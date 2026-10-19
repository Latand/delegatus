# State to SQLite: slice 5b reader inventory

Inventory before implementation, 2026-10-19, base `ab9ad9db`.
Scope follows `state-sqlite-migration.md` §2.1 rows 9–11 and §2.2's
Viewer-only Telegram exception. Later slices and #1872 remain separate.

## Readers and writers before the move

Every owner below reads JSON directly before this slice. Consumers listed in
the third column call the owner's API unless a direct file access is named.

| Legacy file | Direct reader / writer | Consumers, copies, defaults and cascades |
|---|---|---|
| `push-subscriptions.json` | `src/lib/push.ts`: subscription save, notification delivery, dead-endpoint removal | `src/app/api/push/route.ts` saves; files scan invokes question notifications. An absent file means no subscribers. Delivery must remove only the dead subscription it actually sent to, preserving concurrent replacements. |
| `push-sent.json` | `src/lib/push.ts`: notification dedupe read and append | Same notification path; retains the newest 500 attention identifiers. Failed sends do not mark delivery. `push-keys.json` remains a credential file. |
| `review-loop-presets.json` | `src/lib/flows/store.ts`: `loadPresets`, `savePresets` | `flows/commands.ts`, `flows/engine.ts`; missing names are seeded from role definitions, existing operator selections survive. Flow records and artifacts have separate persistence. |
| `workflow-templates.json` | `src/lib/workflows/store.ts`: `loadTemplates`, `saveTemplates` | `workflows/engine.ts`; templates normalize stage configs and merge missing role-derived defaults. `workflows/types.ts` mentions the filename only. Workflow records and artifacts have separate persistence. |
| `role-presets.json` | `src/lib/roles/store.ts`: override load/save, retirement journal read, mapping change's raw-file undo | `roles/retirements.ts` (startup normalization and one-time retirement), `roles/registryLock.fixture.ts` (test child); roles route, MCP role tools, role-based spawn/pipeline resolution, flow and workflow seed derivation. `src/app/api/onboarding/route.ts` checks file existence directly. `scripts/capture-board-geometry.ts` seeds a private fixture. Defaults, variants, scaffold overrides, schema versions 1–5, retirement records and registry revisions must survive. `roles/mcpMapping.ts` writes the separate audit JSONL; an audit refusal must roll back the mapping. |
| `spawn-nesting.json` | `src/lib/agent/nestingPolicy.ts`: load/save | Spawn policy route reads/changes the operator ceiling; `agent/registry.ts` reads it during spawn admission. Default is depth 2; allowed range 1–4. |
| `root-lineage.json` | `src/lib/root/store.ts`: lineage read, adoption and identity creation | `root/adopt.ts`, `attention/service.ts`, `bridge/service.ts`; stable root identity and rollover history, including document revision. A malformed valid-JSON record refuses replacement; absent state creates one stable root. |
| `telegram/reports.json` | `src/lib/telegram/reportStore.ts`: read, update, logout clear | Report runner, schedule, prompt, task, lineage and service paths; Telegram reports routes and report MCP bindings use those APIs. Settings, analyst prompt, cursor, active run, pending settlement, one-shot retry and bounded history move together. Markdown, source plans and agent inboxes remain artifacts. Logout clears the SQLite corpus as well as artifacts. |
| `telegram/registrations.json` | `src/lib/telegram/hostRegistration.ts`: read/write registration ownership map | `telegram/service.ts` registers and unregisters host configs. Registration snapshots restore external Claude config if ownership persistence fails; removal consults the recorded URL and retains operator replacements. External Claude JSON and Codex TOML remain external config. |

The direct TypeScript API consumers are:

- Push: `src/app/api/push/route.ts` and `src/lib/scanner/index.ts`.
- Presets: `src/lib/flows/commands.ts`, `src/lib/flows/engine.ts` and
  `src/lib/workflows/engine.ts`.
- Roles: `src/app/api/roles/route.ts`, `src/lib/mcp/bindings.ts`,
  `src/lib/orchestrator/handoffDigest.ts`, `src/lib/orchestrator/seatCommand.ts`,
  `src/lib/roles/registry.ts`, `src/lib/roles/retirements.ts`,
  `src/lib/viewerInstrumentation.ts`, `src/lib/flows/store.ts` and
  `src/lib/workflows/store.ts`; onboarding uses the presence query.
- Root lineage: `src/lib/root/adopt.ts`, `src/lib/attention/service.ts`,
  `src/lib/bridge/service.ts` and `src/lib/mcp/bindings.ts`.
- Telegram: `src/app/api/telegram/reports/route.ts`,
  `src/lib/telegram/reportRunner.ts` and `src/lib/telegram/service.ts`.

## Python, shell and vendor boundary

Searched tracked sources under `src`, `scripts`, `bin` and `vendor` for all nine
filenames and their path builders, then followed the exported owner APIs.
Reviewed Python file I/O, JSON loads/dumps and environment-provided paths in
`vendor/telegram-mcp/telegram_mcp/runtime.py`, `tools/events.py`, `runner.py`,
`singleton.py`, `install_guard.py`, `bin/telegram-mcp-server.py` and
`bin/telegram-login-bridge.py`.

There is no Python or shell reader/writer of the nine files above. No external
reader needs a new SQLite interface for this slice.

The Python connector reads its session and credentials from its launch
environment (`telegram/packaging.ts`, `bin/telegram-session-reader.mjs`,
`bin/telegram-session-validator.mjs`). The validator reads `session.json` and
`connector-token`. `sessionStore.ts` owns `session.json`, `connection.json`
and the connector token; `connector.ts` owns `connector.json`. These remain
files as §2.2 specifies. The vendor's runtime reads/writes `aliases.json`
through `TELEGRAM_ALIASES_FILE` (with its legacy alias fallback), and
`tools/events.py` appends the incoming JSONL feed. Its install guard reads
package metadata. Its singleton uses lock files. None consumes report settings,
report history or host-registration ownership. The vendor and bridge artifacts
and their checksums need no modification.

The newer bot store (`telegram/bot/store.ts`, `telegram/bot/service.ts`)
already uses `telegram/bot.sqlite`; it needs no JSON migration. Its
`bot-token.json` remains a credential file. Bot report replies, outbound
publication and review polls use the bot database. Connector logs remain
diagnostics.

## Concurrent work checked

Open PR diffs inspected: registry async admission (#3093), relay media (#3089),
memory imports (#3084). Their changes do not modify these store write paths.
The active flow-retirement lane freezes ingress; this slice changes only preset
persistence in `flows/store.ts`, preserving the flow engine and ingress work.
Shared import, activation and demotion helpers retain the earlier slices'
protocol. This slice keeps import and rollback mirrors until #1872 (2026-12-15).

## Serving interfaces after the move

`state/legacyCollections.ts` registers all nine collections for activation and
demotion. `LegacyDocumentStore` supplies count/digest verification, tombstones,
kept source copies, row-revision reconciliation and rollback mirrors. Nested
Telegram source paths explicitly select the root database. Malformed JSON is
preserved with the same durable import gap as the earlier slices; valid JSON
with an unsupported role or root schema is refused unchanged.

Remaining JSON reads in the owners are the pre-activation legacy fallback and
import/rollback protocol. Onboarding and role retirements distinguish an empty
import tombstone from a saved mapping. Role reads inside other collection decoders use an existing import or the
legacy document, so a read never opens a nested import writer. Activation and
role writes still perform the guarded import. The role audit JSONL and Telegram run
artifacts retain their original interfaces.

Push subscriptions use endpoint keys, 32-row keyset pages and conditional
dead-endpoint removal. Push dedupe retains 500 identifiers. Root identity and
unchanged-root adoption read the metadata row; a rollover explicitly requests
the chain. Report history is bounded by its existing retention and stores its
display position with each run. Preset arrays retain positional keys, including
duplicate names and order. Role overrides and retirement entries have separate
keys. Catalog reads still return the requested full catalog. No latency,
throughput or memory improvement is claimed.

New 5b imports use one file-lock attempt; contended admission yields through
`waitForStateLock` under its shared deadline. SQLite reads and writes retain
zero busy timeouts and the release fence. The monitor labels document work
`state.document`; request admission labels identify push, role and policy work.
Each 5b owner retains at most four database handles; decoded document caches
use the existing shared eight-slot byte-bounded cache.
