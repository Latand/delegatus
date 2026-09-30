# Codex service tier implementation verification

Implemented the per-launch, per-stage and per-role Codex tier contract, including
both approved design continuations. Null/absent stage tiers inherit; explicit
priority replaces the role tier; default/standard opts out. Required tiers fail
closed against the model/account catalog, and role preferences fall back with
words in the runtime answer. Thread start/resume carries the tier; later turns,
steers and native starts inherit. Failed/cancelled reconfiguration restores the
exact original tier. Global Codex configuration is never changed by this feature.

## Checks

Every command below ran with fresh `mktemp -d /tmp/…` isolation for
`LLV_STATE_DIR`, `XDG_CONFIG_HOME`, `TMPDIR` and `CODEX_HOME`. HOME and the
legacy account-home overrides also pointed into the sandbox. Temporary
permissions used `umask 077`. Controller URLs used an inert loopback endpoint
on port 1; the runtime socket was unset unless a test declared its own sandbox
socket. No directory sweep was run.

| Command | Pass | Fail | Assertions | Files |
|---|---:|---:|---:|---:|
| `bun test src/lib/accounts/codexServiceTiers.test.ts src/lib/accounts/managerProjectBinding.test.ts src/lib/accounts/projectSelection.test.ts src/lib/roles/store.test.ts src/lib/roles/registry.test.ts src/lib/runtime/codexTurnProfile.test.ts src/lib/runtime/spawnTransport.test.ts src/lib/pipelines/roles.test.ts src/lib/pipelines/stageDigest.test.ts src/lib/mcp/schemaParity.test.ts` | 176 | 0 | 5446 | 10 |
| `bun test src/lib/runtime/structuredSpawn.integration.test.ts src/lib/runtime/codexAppServerHost.test.ts src/lib/runtime/structuredControls.test.ts src/lib/runtime/structuredReconfigure.test.ts src/lib/agent/registry.reseat.test.ts` | 352 | 0 | 1486 | 5 |
| `bun test src/lib/pipelines/engine.test.ts` | 449 | 0 | 4200 | 1 |
| `bun test src/lib/pipelines/stageAccountBinding.test.ts` | 13 | 0 | 61 | 1 |
| `bun test src/lib/pipelines/store.test.ts` | 29 | 0 | 187 | 1 |
| `bun test src/lib/mcp/compactAnswers.test.ts src/lib/mcp/bindings.test.ts` | 96 | 0 | 2054 | 2 |
| `bun test src/lib/accounts/codexAppServer.test.ts src/lib/accounts/migration/provider.test.ts` | 56 | 0 | 280 | 2 |
| `bun test src/lib/runtime/spawnTransport.test.ts src/app/api/spawn/route.test.ts` | 89 | 0 | 412 | 2 |
| `bun test src/components/RuntimePill.dom.test.tsx src/lib/scanner/effort.test.ts` | 33 | 0 | 125 | 2 |
| `bun test src/lib/mcp/rolePresets.test.ts` | 17 | 0 | 72 | 1 |
| `LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<Chromium binary> bun test src/components/kanban/kanbanBoard.browser.test.tsx --test-name-pattern 'Codex service tier rendered evidence'` | 1 | 0 | 26 | 1 |

Total: **1311 passing test executions**, zero failures,
**14349 assertions**, across 27 distinct named files.
The transport file was repeated in the final route check. The browser case
covers English/Ukrainian at desktop 1280 and phone 390 pixels, for both the
conversation runtime pill/speed surface and the active reviewer mapping row.
Rendered records: [rendered.json](rendered.json). Captures stay under
`.artifacts/codex-service-tier/`.

- `bunx tsc --noEmit`: exit 0.
- `bun scripts/privacy-publication-gate.ts --base <merge-base> --check-commits`: PASS.
- `git diff --check`: PASS.
- The prior attempt ran `bun install --frozen-lockfile` in this lane and installed
  481 packages; this continuation used those installed dependencies.

Earlier failing runs were corrected and rerun; loader errors are excluded from
the passing counts. Two stage-binding movement fixtures also failed on the
baseline: they now explicitly seed legacy drafts without a delivery claim,
because current claimed lanes refuse repository moves. Route permission fixtures
now use inert structured dependencies and a declared sandbox socket. An early
MCP group emitted default controller callbacks rejected with HTTP 401; subsequent
checks pinned control traffic to port 1. No successful live mutation was observed.

## Review and boundaries

Self-review checked launch identity, account-pool narrowing, explicit versus
preferred admission, actual fallback labels, shared rollback, migration adoption,
scanner provenance and rendered labels. A preferred fallback keeps its actual
no-tier answer on replay, and no-tier spawns keep their legacy digest. The
existing browser driver was extended; no new capture driver was added.

The Codex host source changes are limited to its import at line 8, option at
line 184, live catalog assertion at line 1469, resume parameter at line 1483,
and start parameter at line 1489. Native queue files and turn/steer implementations
were unchanged. The direct migration-successor adoption passes the same tier
resolver into that host check.

Unverified: live Codex app-server tier acceptance and its response to an
unsupported account tier; deployed UI; hosted CI; production build; full repository
suite. The live runtime host and live conversations were never launched, restarted
or stopped. Verification used fixture app-servers and an ephemeral browser fixture.
No pull request or deployment was made.

## Files in the implementation series

63 files, including the prior rollback commit and this report:

- `docs/design/codex-service-tier.md`
- `evidence/codex-service-tier/rendered.json`
- `evidence/codex-service-tier/verification.md`
- `src/app/api/spawn/route.test.ts`
- `src/components/RuntimePill.dom.test.tsx`
- `src/components/RuntimePill.tsx`
- `src/components/kanban/issue1695Evidence.fixture.tsx`
- `src/components/kanban/kanbanBoard.browser.test.tsx`
- `src/components/onboarding/AgentMappingTable.tsx`
- `src/components/runtimeProfile.ts`
- `src/lib/accounts/codexAppServer.test.ts`
- `src/lib/accounts/codexAppServer.ts`
- `src/lib/accounts/codexServiceTiers.test.ts`
- `src/lib/accounts/codexServiceTiers.ts`
- `src/lib/accounts/manager.ts`
- `src/lib/accounts/managerProjectBinding.test.ts`
- `src/lib/accounts/migration/contracts.ts`
- `src/lib/accounts/migration/provider.test.ts`
- `src/lib/accounts/migration/provider.ts`
- `src/lib/agent/cli.ts`
- `src/lib/agent/registry.ts`
- `src/lib/agent/spawnCommand.ts`
- `src/lib/agent/spawnIdentity.ts`
- `src/lib/i18n/en.ts`
- `src/lib/i18n/uk.ts`
- `src/lib/mcp/bindings.test.ts`
- `src/lib/mcp/compactAnswers.test.ts`
- `src/lib/mcp/compactAnswers.ts`
- `src/lib/mcp/rolePresets.test.ts`
- `src/lib/mcp/schemaParity.test.ts`
- `src/lib/mcp/server.ts`
- `src/lib/pipelines/engine.test.ts`
- `src/lib/pipelines/engine.ts`
- `src/lib/pipelines/roles.test.ts`
- `src/lib/pipelines/roles.ts`
- `src/lib/pipelines/stageAccountBinding.test.ts`
- `src/lib/pipelines/stageDigest.test.ts`
- `src/lib/pipelines/stageDigest.ts`
- `src/lib/pipelines/store.test.ts`
- `src/lib/pipelines/store.ts`
- `src/lib/pipelines/types.ts`
- `src/lib/roles/mcpMapping.ts`
- `src/lib/roles/paramConfig.ts`
- `src/lib/roles/store.test.ts`
- `src/lib/roles/store.ts`
- `src/lib/roles/types.ts`
- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/codexAppServerHost.ts`
- `src/lib/runtime/codexTurnProfile.test.ts`
- `src/lib/runtime/codexTurnProfile.ts`
- `src/lib/runtime/contracts.ts`
- `src/lib/runtime/spawnTransport.test.ts`
- `src/lib/runtime/spawnTransport.ts`
- `src/lib/runtime/structuredControls.test.ts`
- `src/lib/runtime/structuredControls.ts`
- `src/lib/runtime/structuredReconfigure.test.ts`
- `src/lib/runtime/structuredSpawn.integration.test.ts`
- `src/lib/runtime/structuredSpawn.ts`
- `src/lib/scanner/effort.test.ts`
- `src/lib/scanner/effort.ts`
- `src/lib/scanner/index.ts`
- `src/lib/scanner/observe.ts`
- `src/lib/types.ts`
