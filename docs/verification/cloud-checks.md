# Cloud checks: verification

Verified 2026-10-24 13:05 UTC against main `e92a0ddde58e07ec491e64b96b4ca2c722ebab60`.
The checks execute the working tree in a scratch export. The SHA-256 of
`git diff --binary HEAD -- .githooks scripts src` is
`c2ad8b295a6d7ae4f399640a505f6b82fd72dded66c017ff9035839240641bb8`.
Documentation is excluded from that digest so this report can record it.

Result 72 applied with `git apply --3way` without conflicts after updating the
assigned branch to current main. Its original diff SHA-256 is
`48e623d117d1f3c17877d559a6d352629f7253745a1f63a7aa98312fd0c5f66f`.
PR #3302 remained open when main and its merge status were rechecked, so its
`cloudStage.ts` and `cloudHostedClient.ts` transport was absent from main.

## Behavior verified

- Local privacy passes before Cloud dispatch. A privacy refusal prevents both
  dispatch and fallback. Publication binds the actual outgoing commit, lane
  and current stage to the hook.
- Cloud command evidence binds the command, turn, head, tree, comparison base
  and exit code. Missing or malformed evidence blocks publication. Tracked
  and untracked source edits invalidate a receipt. The remote command disables
  hook skipping and recursive Cloud or SSH dispatch.
- A complete Cloud result decides immediately. Confirmed outages and Cloud
  limits permit one local fallback. A red check, account refusal or invalid
  evidence never enables fallback. Account refusals during reconnect also block it.
- Project, lane and stage choices persist in local Git configuration. Stage
  overrides inherit through lane and project defaults. A separate process reads
  the persisted choice. Refused writes and invalid stored values fail closed.
  Git configuration access is asynchronous and bounded.
- UI and MCP use the checks endpoint. The endpoint validates stage membership,
  request bodies and origins. MCP accepts stage choices; the voice companion's
  action record describes them.
- Loopback WebSocket fixtures verify account and service handshake failures,
  configured subprotocol negotiation and invalid-configuration refusal. Other
  transport tests use fake RPC. No live Cloud task was launched.

## Commands and isolation

Every heavy command used the stage's supplied `gate-slot.sh` wrapper, serially,
with `LLV_GATE_RUNNER=off` because the SSH runner is retired. Each test file had
private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, plus a closed
`LLV_VIEWER_CONTROL_URL`. No suite ran against the operator's state.

Command payloads were `bunx tsc --noEmit`, `bunx eslint` with explicit touched
TS/TSX paths, and `bun run test` with each explicit path below. The final
transport and browser changes received fresh typecheck, lint and test runs.

| Final check | Result |
| --- | --- |
| Typecheck | Exit 0 |
| Touched-file ESLint | Exit 0; nine warnings on existing declarations |
| Transport tests | 37 passed, zero failed |
| Settings tests | 3 passed, zero failed |
| Checks API tests | 3 passed, zero failed |
| Browser case | 1 passed, zero failed; eight rendered combinations |
| Staged whitespace, privacy and lint | Required by the commit's enabled pre-commit hook |
| `git diff --check HEAD` | Exit 0 |

The direct test inventory contains 16 files. The final feature reruns replace
earlier observations for the first three rows; counts are not summed across reruns.

| File | Direct pass / fail | Final comparison |
| --- | ---: | --- |
| `scripts/cloud-checks.test.ts` | 37 / 0 | Green |
| `scripts/cloud-check-settings.test.ts` | 3 / 0 | Green |
| `src/app/api/pipelines/[id]/checks/route.test.ts` | 3 / 0 | Green |
| `scripts/local-gate.test.ts` | 59 / 10, one error | Zero new; same incomplete runner failure on both sides |
| `scripts/local-gate.receipts.test.ts` | 2 / 6 | Zero new; six pre-existing |
| `scripts/local-gate-tests.test.ts` | 66 / 1 | Zero new; one pre-existing |
| `scripts/gate-cache.test.ts` | 10 / 0 | Green |
| `scripts/gate-runner/client.test.ts` | 17 / 1 | Zero new; one pre-existing |
| `src/lib/mcp/schemaParity.test.ts` | 37 / 1 | Zero new; one pre-existing |
| `src/lib/mcp/server.test.ts` | 101 / 0 | Green |
| `src/lib/pipelines/git.test.ts` | 178 / 2, two errors | Zero new; three normalized pre-existing sites |
| `src/lib/voiceCompanion/readPaths.test.ts` | 16 / 2 | Zero new; two pre-existing |
| `src/lib/voiceCompanion/tools.test.ts` | 11 / 1 | Zero new; one pre-existing |
| `src/components/pipelines/PipelineStrip.test.ts` | 7 / 0 | Green |
| `src/components/pipelines/PipelineStrip.render.test.tsx` | 16 / 0 | Green |
| `src/components/pipelines/PipelineStrip.dom.test.tsx` | 9 / 0 | Green |

## Baseline comparison and limits

Each of the eight red files was compared separately using:

```sh
bun scripts/local-gate-tests.ts --base e92a0ddde58e07ec491e64b96b4ca2c722ebab60 <explicit-file>
```

All eight comparator invocations exited 0 with zero new failures. The raw
suites remain red. The gate test file was incomplete on both sides with the
same unidentified between-tests runner error; the project's comparator admits
that matching infrastructure failure. This does not establish a complete pass
for that file's lifecycle assertions.

The remaining comparisons reproduced receipt and CPU-containment refusals,
the existing environment-inventory omissions, a create-pipeline description
assertion, publication-close lifecycle failures and existing voice/catalog
assertions. The six real publication-budget/hook cases passed, including the
new lane, stage and outgoing-head assertions.

## Rendered evidence and UI scope

The existing kanban driver ran only `Cloud check execution choices`, with
`LLV_KANBAN_BROWSER_TEST=1` and an explicit Chromium binary. English and
Ukrainian, light and dark, and widths 1440 and 390 produced eight frames under
`.artifacts/cloud-checks/` in the scratch export. Every frame was inspected
visually. The controls are visible and the functional persistence assertions pass.
This supplies evidence for the separate UI review.

The first browser attempt failed before rendering because its temporary socket
path was too long. The successful rerun used a short alias into the owned scratch
root, with native desktop scrollbars enabled.

`src/components/pipelines/PipelineCheckSettings.tsx` is byte-identical to the
component supplied in result 72. No lane-settings UI rewrite was made.
`.github/workflows` is unchanged. No performance improvement is claimed by
these checks.
