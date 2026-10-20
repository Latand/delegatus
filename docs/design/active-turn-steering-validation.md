# Active-turn steering implementation verification

The five agent/seat delivery call sites use `steer-or-queue`. Codex steering has detached observation, same-operation queue fallback, an order barrier, and unknown outcomes that require verification. The approved journal exception keeps the observed turn on the receipt without persisting it as an outbox fence. Plain sends and the other policies keep their fences.

The real-CLI cases exercise sampling, a running `exec_command`, idle delivery, a compaction refusal, and turn-ending races. `dropped-after` accepts either observed protocol outcome after steer acceptance: Codex may consume the input before interruption, or the host may queue it after observing `steer-dropped`. The delayed case pauses beyond the CLI's 10-second yield before waiting on those protocol events. Every outcome asserts original identity, exactly one recorded user item, retained agent origin, and no native-queue entry. Journal/receipt tests also exercise refusal, dropped input and unknown outcome, plus migration into an active successor turn.

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

## Interrupted steering regression, 2026-10-20

CI run 39359752101 failed `dropped-after` on Codex 0.163.0 at
02:51:51Z (job 118426922381) and 0.162.1 at 02:52:12Z
(job 118426922774). Both logs show the supplement becoming `delivered`
before the interrupt receipt becomes `interrupted`. The fixture then waits
30 seconds for `queued / steer-dropped`, an outcome that cannot follow that
confirmed delivery. The reviewed fixture added an observed-outcome wait, but
retained pre-interrupt assertions that still required the input to be absent.

The baseline at `6be3a78b7` was measured with Bun 1.4.0, real npm-installed
Codex executables, and the CI fixture's local Responses provider. The provider
uses no account credentials. Every run has fresh HOME, XDG_CONFIG_HOME,
XDG_CACHE_HOME, XDG_DATA_HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, LLV_STATE_DIR and
TMPDIR, and a closed Viewer control URL. Runs execute sequentially through
`scripts/gate-slot.sh`, with the repeated batch holding one CPU admission.

| Codex | Original dropped-after alone | Original six-case file | Controlled consumed-input ordering |
|---|---:|---:|---:|
| 0.162.1 | 20/20 pass (100%) | 20/20 pass (100%) | 0/1 pass; expected timeout |
| 0.163.0 | 20/20 pass (100%) | 20/20 pass (100%) | 0/1 pass; expected timeout |
| 0.159.0 control | 20/20 pass (100%) | Not sampled | 0/1 pass; expected timeout |

The controlled probe exports the baseline and completes the first provider
response after steer acceptance. It waits for the next provider request and
the supplement's delivered receipt before issuing the interrupt, then retains
the original dropped-only assertion. It reproduces that assertion's timeout
on all three versions. Captured protocol frames contain both
`item/completed` for the supplement and `turn/completed` with `interrupted`
status. No required protocol event is missing; the absent transition is
`queued / steer-dropped`. Natural intermittency was observed in CI; the local
unforced samples stayed green.

`src/lib/runtime/codexSteerDelivery.integration.test.ts` covers both outcomes.
`dropped-after` waits for a real tool's `tool-running` handshake, holds that
tool through steer acceptance, and interrupts before the tool can finish. It
waits for the observed completion or `steer-dropped` event before deciding
which outcome occurred. The separate
`landed-before-interrupt` case waits for the supplement's `item/completed`
and durable delivered receipt before issuing the interrupt. Both wait for
the original turn's `turn/completed` and the interrupt receipt, then require
their respective queued or delivered outcome. Both reopen the journal, compare
the retained receipt, replay the original operation key, and require exactly
one recorded supplement with its original agent origin. The 30-second wait
and 90-second test limits retain their original values.

The measured defect is in the fixture's ordering assumption. Host settlement
continues to use its existing canonical-item and rollout evidence. The Claude
reap and delivery-terminalization lanes retain their own source changes.

The focused repetition command is:

```sh
npm install --prefix "$CLI_ROOT" --no-save --ignore-scripts "@openai/codex@$VERSION"
export NATIVE_CODEX_QUEUE_TEST_BINARY="$CLI_ROOT/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
bash scripts/gate-slot.sh bun test ./src/lib/runtime/codexSteerDelivery.integration.test.ts \
  --test-name-pattern 'real Codex steer delivery: (dropped-after|landed-before-interrupt)$'
```

Repeat the test command 20 times per version with the fresh roots described
above. The required acceptance case selects `real Codex steer delivery:
dropped-after$`; the delayed ordering probe selects
`real Codex steer delivery: dropped-after-delayed$`. The baseline file campaign
omits the name filter. The complete CI command is
`bun scripts/verify-native-codex-runtime.ts "$NATIVE_CODEX_QUEUE_TEST_BINARY"`.

Historical focused campaign, before the timing repair (same Bun, provider and isolation):

This campaign used fixture hash
`7d48d0c098c9d57beca5ccf78bd0856995aead7a06aa83c8ea51b3338c60a260` and
selected `dropped-after` plus `landed-before-interrupt`. It predates the delayed
ordering case and the removal of pre-settlement assertions; the results below
are historical evidence, not validation of the final fixture.

| Codex | Dropped input | Input consumed before interrupt |
|---|---:|---:|
| 0.154.0 | 20/20 consecutive pass (100%) | 20/20 consecutive pass (100%) |
| 0.159.0 | 20/20 consecutive pass (100%) | 20/20 consecutive pass (100%) |
| 0.162.1 | 20/20 consecutive pass (100%) | 20/20 consecutive pass (100%) |
| 0.163.0 | 20/20 consecutive pass (100%) | 20/20 consecutive pass (100%) |

Each of the 80 independent test processes completed both historical cases:
160 passed, 0 failed. The tested integration file's SHA-256 was
`7d48d0c098c9d57beca5ccf78bd0856995aead7a06aa83c8ea51b3338c60a260`.

The complete CI native runner passed locally against that historical source:

| Codex | Named files completed | Passed | Skipped | Failed |
|---|---:|---:|---:|---:|
| 0.162.1 | 59 | 1472 | 0 | 0 |
| 0.163.0 | 59 | 1472 | 0 | 0 |

Hosted CI follows pipeline publication. The stage does not push or create a
remote branch.

## Final focused campaign after timing repair

The final integration fixture SHA-256 is
`6457da98e68e696656e313cc8bb2d3b09df3748bb437b3b4b073e25e130bb416`.
With Bun 1.4.0 and the local Responses provider, `dropped-after` passed 20/20
consecutive isolated runs on each CI matrix version: 0.154.0, 0.159.0, 0.162.1
and 0.163.0. The result is 80 passed, 0 failed. The delayed case
`dropped-after-delayed` passed once on each of the same four versions; each run
waited beyond the CLI's 10-second yield and then settled from the observed
protocol outcome. No protocol-event timeout occurred. Every run retained its
receipt, replayed the original operation without another send, and recorded
one supplement item.

The repeated command below selects only `dropped-after`; each invocation gets
fresh roots and runs through the project's CPU gate. To repeat the delayed
probe, change the test-name pattern to
`real Codex steer delivery: dropped-after-delayed$` and run it once per
version.

```sh
set -euo pipefail
CAMPAIGN_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/steer-campaign.XXXXXX")
GATE=scripts/gate-slot.sh
for VERSION in 0.154.0 0.159.0 0.162.1 0.163.0; do
  CLI_ROOT="$CAMPAIGN_ROOT/cli-$VERSION"
  npm install --prefix "$CLI_ROOT" --no-save --ignore-scripts "@openai/codex@$VERSION"
  BINARY="$CLI_ROOT/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex"
  test "$("$BINARY" --version)" = "codex-cli $VERSION"
  for ITERATION in $(seq -w 1 20); do
    ROOT="$CAMPAIGN_ROOT/run-$VERSION-$ITERATION"
    mkdir -p "$ROOT/home" "$ROOT/config" "$ROOT/cache" "$ROOT/data" \
      "$ROOT/state" "$ROOT/tmp" "$ROOT/codex" "$ROOT/claude"
    HOME="$ROOT/home" XDG_CONFIG_HOME="$ROOT/config" XDG_CACHE_HOME="$ROOT/cache" \
      XDG_DATA_HOME="$ROOT/data" LLV_STATE_DIR="$ROOT/state" TMPDIR="$ROOT/tmp" \
      CODEX_HOME="$ROOT/codex" CLAUDE_CONFIG_DIR="$ROOT/claude" \
      NATIVE_CODEX_QUEUE_TEST_BINARY="$BINARY" \
      bash "$GATE" bun test ./src/lib/runtime/codexSteerDelivery.integration.test.ts \
        --test-name-pattern 'real Codex steer delivery: dropped-after$'
  done
done
```

The final test covers either observed settlement path after the steer is
accepted. Codex may report the supplement as completed before interruption, or
the host may observe `steer-dropped` and queue the same operation for delivery.
The 30-second event deadline and 90-second test limit remain unchanged.
