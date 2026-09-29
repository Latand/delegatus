# Active-turn steering implementation verification

The five agent/seat delivery call sites use `steer-or-queue`. Codex steering has detached observation, same-operation queue fallback, an order barrier, and unknown outcomes that require verification. The approved journal exception keeps the observed turn on the receipt without persisting it as an outbox fence. Plain sends and the other policies keep their fences.

The real-CLI cases exercise sampling, a running `exec_command`, idle delivery, a compaction refusal, and both turn-ending race orders. They assert original identity, exactly one recorded user item, retained agent origin, and no native-queue entry. Journal/receipt tests also exercise refusal, dropped input and unknown outcome, plus migration into an active successor turn.

## Isolation and commands

Every command ran with three separate fresh directories:

```sh
LLV_STATE_DIR=$(mktemp -d /tmp/steer-state.XXXXXX) \
XDG_CONFIG_HOME=$(mktemp -d /tmp/steer-config.XXXXXX) \
TMPDIR=$(mktemp -d /tmp/steer-tmp.XXXXXX) <command>
```

The native verification driver creates additional private account/config/temp roots and runs only its named files. `CI_CODEX_BINARY` below denotes the isolated Codex 0.154.0 fixture executable; `command -v codex` selects installed Codex 0.159.0. Neither run uses a real account or live conversation. Full-driver totals sum all child test processes.

## Test execution ledger

Rows include intermediate failed checks and subsequent corrected runs. The earliest failures exposed stale test expectations and preparation timing; combined runs also exposed deleted-registry fixtures and DOM/global contamination. Fixture resets and separate processes fixed those. One intermediate runner overlapped the order-barrier edit; the stable final runs verify the completed barrier. No production change was made for these test-fixture defects.

| Command | Passed | Failed |
|---|---:|---:|
| `bun test src/runtime-host/journal.test.ts src/lib/runtime/structuredDeliveryQueue.test.ts src/lib/runtime/codexAppServerHost.test.ts` | 316 | 7 |
| `NATIVE_CODEX_QUEUE_TEST_BINARY=$(command -v codex) bun test src/lib/runtime/codexSteerDelivery.integration.test.ts` | 0 | 5 |
| `NATIVE_CODEX_QUEUE_TEST_BINARY=$(command -v codex) bun test src/lib/runtime/codexSteerDelivery.integration.test.ts` | 5 | 0 |
| `bun test src/runtime-host/journal.test.ts src/lib/runtime/structuredDeliveryQueue.test.ts src/lib/runtime/codexAppServerHost.test.ts` | 322 | 1 |
| `bun test src/app/api/tmux/route.test.ts src/lib/agent/registry.test.ts src/lib/mcp/bindings.test.ts src/lib/mcp/bridgeDirective.test.ts src/lib/mcp/orchestratorSendRecovery.test.ts src/lib/orchestrator/boardReportRun.test.ts src/lib/spawnNotice/sweep.test.ts src/lib/runtime/commands.test.ts` | 288 | 5 |
| `bun test src/lib/runtime/structuredDelivery.integration.test.ts` | 39 | 0 |
| `bun scripts/verify-native-codex-runtime.ts "$CI_CODEX_BINARY"` | 706 | 9 |
| `bun test src/lib/mcp/bindings.test.ts` | 83 | 3 |
| `bun test src/lib/runtime/structuredDelivery.integration.test.ts` | 42 | 0 |
| `bun test src/lib/mcp/bindings.test.ts` | 86 | 0 |
| `bun test src/app/api/tmux/route.test.ts --timeout 20000` | 29 | 0 |
| `bun test src/lib/agent/registry.test.ts --timeout 20000` | 129 | 0 |
| `bun test src/lib/mcp/bridgeDirective.test.ts --timeout 20000` | 15 | 1 |
| `bun test src/lib/mcp/orchestratorSendRecovery.test.ts --timeout 20000` | 6 | 0 |
| `bun test src/lib/orchestrator/boardReportRun.test.ts --timeout 20000` | 9 | 0 |
| `bun test src/lib/orchestrator/deputySweep.test.ts --timeout 20000` | 11 | 0 |
| `bun test src/lib/spawnNotice/sweep.test.ts --timeout 20000` | 13 | 0 |
| `bun test src/lib/runtime/commands.test.ts --timeout 20000` | 5 | 0 |
| `NATIVE_CODEX_QUEUE_TEST_BINARY=$(command -v codex) bun test src/lib/runtime/codexSteerDelivery.integration.test.ts` | 6 | 0 |
| `bun test src/runtime-host/journal.test.ts src/lib/runtime/structuredDeliveryQueue.test.ts src/lib/runtime/codexAppServerHost.test.ts` | 323 | 0 |
| `bun test src/lib/mcp/bridgeDirective.test.ts src/app/api/tmux/route.test.ts` | 45 | 0 |
| `bun test src/lib/runtime/structuredDeliveryQueue.test.ts` | 79 | 0 |
| `bun scripts/verify-native-codex-runtime.ts "$CI_CODEX_BINARY"` | 633 | 1 |
| `bun scripts/verify-native-codex-runtime.ts "$CI_CODEX_BINARY"` | 786 | 7 |
| `bun test src/lib/runtime/codexAppServerHost.test.ts` | 152 | 0 |
| `bun test src/lib/runtime/voicePersonaMandate.test.ts src/lib/mcp/voiceUtteranceContext.test.ts` | 27 | 0 |
| `bun scripts/verify-native-codex-runtime.ts "$CI_CODEX_BINARY"` | 1044 | 0 |
| `bun scripts/verify-native-codex-runtime.ts $(command -v codex)` | 631 | 4 |
| `bun scripts/verify-native-codex-runtime.ts "$(command -v codex)" --steering-only` (approved installed-CLI selection) | 6 | 0 |
| `bun scripts/verify-native-codex-runtime.ts <fixture-package-directory>` (incorrect executable argument on resume) | 623 | 12 |
| `bun scripts/verify-native-codex-runtime.ts "$CI_CODEX_BINARY"` (resume; concurrent known-value privacy scan) | 634 | 1 |
| `bun scripts/verify-native-codex-runtime.ts "$CI_CODEX_BINARY"` (resume retry) | 1009 | 2 |
| `bun test src/components/TmuxComposer.reconciliation.dom.test.tsx` | 5 | 0 |
| `bun test src/components/TmuxComposer.reconciliationExpiry.dom.test.tsx` | 1 | 0 |
| `bun test src/components/TmuxComposer.pendingImages.dom.test.tsx` | 32 | 0 |
| `bun scripts/verify-native-codex-runtime.ts "$CI_CODEX_BINARY"` (final complete invocation after approved selection) | 1044 | 0 |

The full installed-CLI run stops in its first batch: two fixtures assert exactly Codex 0.154.0 (`nativeCodexQueue.test.ts:32`, `codexHistoryReader.test.ts:438`), while the installed CLI is 0.159.0. Native-queue cold-recovery small/large cases also fail (delivery deadline and resume timeout). Its six active-turn steering cases all pass. Later batches are not exercised by that invocation. The full CI-pinned driver completes all 29 batches: 1,044 passed, 0 failed.

**Approved verification scope.** Design §5 now keeps the full CI-pinned run as the gate and selects group A on installed Codex through the existing driver's `--steering-only` option. All six steering cases pass on both versions. The native-queue/history version assertions are unchanged; installed-version cold recovery is deferred to a separate task. The installed full-run failure above is retained as intermediate evidence and does not gate this lane. No pull request or deployment is part of this stage.

The incorrect executable argument on resume selected the fixture package directory instead of its binary. Its twelve failures were spawn permission errors; the corrected invocation uses the fixture's native executable.

The concurrent-scan run timed out in the existing compaction-cap test after 133 seconds against its 120-second limit (36 seconds in the earlier full green run). All other first-batch tests passed, including all six steering cases. The full gate is repeated sequentially after that scan; no fixture limit or product source was changed for this timeout.

That retry passed the compaction-cap case in 79 seconds and all runtime cases, then stopped after 27 batches on two existing composer reconciliation assertions. The reconciliation file passed all five tests on an isolated rerun; the two previously unreached files passed 1 and 32 tests respectively. None of these component files was modified. The final complete invocation passed all 29 batches: 1,044 passed, 0 failed, including all six steering cases; the compaction-cap case completed in 36 seconds.

## Other checks

- `bunx tsc --noEmit`: intermediate runs reported four source/fixture errors, then one missing fixture field. Corrected runs exit 0; repeated after the approved driver selection, exit 0.
- `bunx eslint <changed TypeScript files>`: the repository-pinned ESLint 10.9.1 crashes while loading `react/display-name` (`getFilename` is unavailable). No lint verdict comes from that invocation.
- `bunx eslint@9 <changed TypeScript files>`: the same repository config and rules complete with 0 errors and 6 existing unused-variable warnings. Repeated after the approved driver selection. No dependency or repository lockfile changes.
- `bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD origin/main)`: PASS. The stage result reports `--check-commits` separately after the Delegatus commit.
- `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json LLV_PRIVACY_OCR_LANGUAGES=eng+ukr bun scripts/privacy-publication-gate.ts --require-known-values --base $(git merge-base HEAD origin/main)`: PASS.
- `git diff --cached --check`: PASS.
- Call-site/route checks: policy forwarding, legacy delivery, invalid-policy refusal, held-policy retention, spawn notice, board report and deputy note are covered by the commands above.

## Unverified and deferred

- The repository-pinned ESLint 10 invocation remains unavailable because of its plugin incompatibility; ESLint 9 supplies the lint verdict above.
- The full installed-CLI driver has the intermediate failures described above; its later batches and installed-CLI native-queue cold recovery remain unverified and are outside the approved gate. Installed-CLI steering is verified by the six group A cases.
- Hosted CI and deployed Viewer/runtime-host behaviour were not exercised. No deployment or live send, steer or interrupt was performed.
- The real CLI's narrow last-instant acceptance window without another model response remains deferred by the design; scripted host tests cover recording and adjudication of that ordering.

## Files changed

- `docs/design/active-turn-steering-validation.md`
- `docs/design/active-turn-steering.md`
- `docs/design/board-maintenance-report.md`
- `docs/design/ghost-seat.md`
- `scripts/verify-native-codex-runtime.ts`
- `src/app/api/conversation-host/handlers.ts`
- `src/app/api/tmux/route.test.ts`
- `src/lib/accounts/migration/contracts.ts`
- `src/lib/agent/registry.test.ts`
- `src/lib/agent/registry.ts`
- `src/lib/delivery.ts`
- `src/lib/mcp/bindings.test.ts`
- `src/lib/mcp/bindings.ts`
- `src/lib/mcp/bridgeDirective.test.ts`
- `src/lib/mcp/orchestratorSendRecovery.test.ts`
- `src/lib/orchestrator/boardReportRun.test.ts`
- `src/lib/orchestrator/boardReportRun.ts`
- `src/lib/orchestrator/deputySweep.test.ts`
- `src/lib/orchestrator/deputySweep.ts`
- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/codexAppServerHost.ts`
- `src/lib/runtime/codexSteerDelivery.integration.test.ts`
- `src/lib/runtime/commands.test.ts`
- `src/lib/runtime/commands.ts`
- `src/lib/runtime/contracts.ts`
- `src/lib/runtime/engineHost.ts`
- `src/lib/runtime/structuredDelivery.integration.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.ts`
- `src/lib/runtime/structuredMessageDelivery.ts`
- `src/lib/runtime/voicePersonaMandate.test.ts`
- `src/lib/spawnNotice/sweep.test.ts`
- `src/lib/spawnNotice/sweep.ts`
- `src/runtime-host/journal.test.ts`
- `src/runtime-host/journal.ts`
