# Cloud checks: verification

## Canonical inputs and catalogue failures

Recorded 2026-10-24 UTC. Comparison base:
`0e4b449269ef16772b272d38bed1e06f8b6b4360`.
The SHA-256 of `git diff --binary <comparison-base> -- scripts src/lib/pipelines/cloudHostedClient.ts src/lib/pipelines/cloudHostedErrors.ts`
is `3b9f8246372a39e56f96734e53703689fb0f5ac4358c09a7b93593cc36c15056`.
Documentation is outside that source digest.

`scripts/gate-cache.ts:checkInputEnvironment` captures canonical values and
declared absences. `scripts/local-gate.ts` supplies that manifest to the Cloud
job. `scripts/cloud-checks.ts:cloudCheckInputs` maps tracked file references
into the candidate checkout and refuses unsupported host inputs. The generated
check process starts with a fresh environment, and its receipt binds the manifest
digest. Both the command record and the coordinator require that binding.

`src/lib/pipelines/cloudHostedClient.ts:catalogue` handles the environment and
repository lookups through the same bounded reader and HTTP policy.
`src/lib/pipelines/cloudHostedErrors.ts:hostedNetworkFailure` admits only known
transient transport causes for retry. HTTP refusals, malformed bodies, TLS
failures and unknown errors retain decisive results. Source upload commands
require completed status, exit zero and their recorded turn before proceeding.

Before the source repair, ten targeted regression cases failed on the comparison
base: three input-verdict cases, four real catalogue reset cases and three
unsuccessful upload cases. The input probe returned a false green when the local
check exited 17. Catalogue failures returned 1 instead of the local exit 19.
Unsuccessful uploads returned the local green instead of refusing.

The repaired source was checked in a detached scratch export pinned to the
comparison base and the captured `origin/main`. Its dependencies match the
manifest and lockfile. Commands used the supplied `gate-slot.sh`, serially,
with private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, a closed Viewer
control URL and SSH runner dispatch disabled.

| Explicit test file | Result |
| --- | --- |
| `scripts/cloud-checks.test.ts` | 94 passed |
| `scripts/cloud-check-config.test.ts` | 8 passed |
| `scripts/gate-cache.test.ts` | 13 passed |
| `src/lib/pipelines/cloudHostedClient.test.ts` | 65 passed |

The command for each file was `bun run test <file>`. The generated Cloud
commands execute fixture repositories without network installs. Red, green and
absent declared inputs match the local canonical environment, including tracked
file remapping and quoted Unicode values. Missing and mismatched input bindings
refuse. Both catalogue endpoints experience real connection and response-body
resets: two attempts produce exactly one local run, preserving exit 19.
Permanent catalogue refusals invoke no local checks. Declined and failed uploads,
including exit-zero records, stop before further pages or a check turn; verified
transfer outages preserve the retry and single-local policy. The six existing
unconfigured hook cases still verify one local plan for default, Cloud and local
selections, with red and green outcomes.

`node_modules/.bin/tsc --noEmit --incremental false` and ESLint on all seven
touched TypeScript files exit 0 without diagnostics. `git diff --check` passes.

No live Cloud job or remote push is part of this verification. UI components
remain for the separate UI stage.

## Unconfigured project publication repair

Recorded 2026-10-24 following the operator's publication continuation. This
section supersedes the earlier missing-setup refusal. Projects without a Cloud
environment use the existing local check plan immediately. Configured projects
retain the shared hosted transport, decisive verdicts and confirmed outage policy.

Main was merged by a merge commit. The repair base is
`c9bd352a51e2ec532cc3902f3612fe8eaa37570b`.
The SHA-256 of `git diff --binary <repair-base> -- scripts` is
`305ad935eeee2364e341be71774d57fec571155ff5f1f742388e39e077cd20ca`.

`scripts/cloud-check-config.ts` returns an unconfigured result before selecting
an account. `scripts/local-gate.ts` then runs its existing concurrent privacy
and admitted-check pair, without creating a Cloud job or retrying. Invalid
configured bindings, account refusals and revoked configuration still refuse.
The project settings reader supplies the binding; lane and stage selectors
supply the producer context. Direct hooks and lane publication share this path.

The shared transport's larger import graph also exposed receipt-scanner failures
on JSON and executable shebangs. `scripts/gate-cache.ts` retains data files as
fingerprinted inputs, scans imports only in source files, and removes the
shebang only from the parser input. Fingerprints still read the original bytes.
Malformed source continues to refuse.

### Focused checks and reproduction

All test commands used the supplied `gate-slot.sh`, serially, from a scratch
export with isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, a closed
Viewer control URL and `LLV_GATE_RUNNER=off`. The borrowed dependencies match
the manifest and lockfile, including TypeScript, ESLint and WebSocket packages.

| Test file | Result |
| --- | --- |
| `scripts/cloud-check-config.test.ts` | 8 passed |
| `scripts/cloud-checks.test.ts` | 62 passed |
| `scripts/gate-cache.test.ts` | 12 passed |
| `src/lib/pipelines/cloudHostedClient.test.ts` | 65 passed |
| `scripts/local-gate.test.ts`, selected planning/isolation/no-change cases | 4 passed, 65 filtered |

Commands were `bun run test <explicit-file>`. The four local-gate cases used
`--test-name-pattern='^commit plan|^the fetch before planning|^state isolation|^pre-push hook on a branch behind main'`.

The selector regression fails on the repair base with the reported missing
environment refusal. The six unconfigured hook cases also fail on that source:
default and explicit Cloud selections refuse the missing environment; explicit
local selection reaches the receipt-scanner failure. On the repaired source,
all six pass. Their command records verify one privacy invocation and one type
check for default, Cloud and local selections, with matching green and red
results and no Cloud dispatch or outage retries. These routing fixtures use
command-recording check shims and a fixture-local admission stub. Native
admission is covered separately; the containing test run uses the real wrapper.

Both new receipt-scanner tests fail on the repair base. The repaired tests
verify data fingerprint invalidation, shebang import traversal and malformed
source refusal. A read-only probe also traverses the real 370-file gate graph.

The separate `privacy refusal stops running admitted checks and their detached
helper` lifecycle case fails before its PID file is created. A fresh run on a
clean detached checkout of the repair base reproduces the same missing-file
failure. The native lifecycle case remains unverified in this environment; no
full pass of the local-gate lifecycle suite is claimed.

The final `node_modules/.bin/tsc --noEmit` and ESLint on all six touched
TypeScript files exit 0 without diagnostics. The verified export's six source
files match the stage checkout byte for byte. `bun run privacy:check` passes
with committed fingerprints and `--check-commits --base origin/main`.
`git diff --cached --check` also exits 0. This full privacy run completed
before the final main reconciliation below.

Main then advanced to `0c7f7a894`, landing the already integrated Cloud stage
transport. The incoming transport is byte-identical to `67b0ff312`. Resolving
its add/add conflict preserves the reviewed shared transport and leaves the
verified source tree unchanged. After reconciliation, typecheck, all 65 hosted
client tests, all 62 Cloud-check tests and ESLint on the resolved transport
pass again. The main update is retained through a merge commit.

No live Cloud job or push was performed. UI components remain for the separate
UI stage.

## Backend repair verification

Recorded 2026-10-24. This section supersedes the original transport and
configuration evidence below. Main was merged by a merge commit. The reviewed
Cloud stage implementation from PR #3302, revision `67b0ff312`, was integrated
so stage execution and publication checks use one hosted connection.

The comparison base is `6ebe5f6f68364fb87ba3cb6d62dbe31457ec664d`.
The SHA-256 of `git diff --binary <base> -- .githooks scripts src test-preload.ts`
is `5397e60f2248aabdb863ec5b5c03e143e7dca2d7abe86b36f1f10921c1004bcb`.
Documentation and inherited evidence files are outside that source digest.

The focused regressions verify all five backend findings:

- Managed project settings and the project's Codex account selection supply
  the environment and native authentication. A loopback hosted service receives
  initialization, source transfer and the check command, returning its receipt.
  Missing setup refuses after privacy without connecting or executing locally.
- Terminal command failures and invalid receipts block before another turn
  read or result page. A later connection failure cannot replace that refusal.
- Stage execution and checks share native authentication, initialization,
  environment catalog validation and RPC through `cloudHostedClient.ts`.
- HTTP 400, 404, 426 and an unrecognized 418 refuse without local work. HTTP
  503 produces two observed handshakes followed by exactly one local run.
  A permanent refusal during outage recovery also blocks fallback.
- Server requests with colliding IDs leave the genuine RPC response pending.
  Frames with empty or null method values are excluded from responses too.

Every heavy command ran serially through the stage-supplied `gate-slot.sh` in
a scratch export, with fresh isolated HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR, a closed Viewer control URL and `LLV_GATE_RUNNER=off`.
The native authentication dependency was stubbed for loopback tests; no live
Cloud job ran. UI components were left for the separate UI stage.

| Check | Result |
| --- | --- |
| `node_modules/.bin/tsc --noEmit` | Exit 0 |
| `node_modules/.bin/eslint` on all 29 touched TS files | Exit 0, no warnings |
| `scripts/cloud-checks.test.ts` | 58 passed |
| `scripts/cloud-check-config.test.ts` | 8 passed |
| `src/lib/pipelines/cloudHostedClient.test.ts` | 65 passed |
| `src/lib/pipelines/cloudStage.test.ts` | 11 passed |
| `src/lib/pipelines/engine.cloud.test.ts` | 47 passed |
| `src/lib/transfer/transferExits.test.ts` | 23 passed |
| `src/lib/testing/testGitIsolation.test.ts` | 8 passed |
| `scripts/gate-cache.test.ts` | 10 passed |
| `src/lib/pipelines/git.test.ts`, `-t 'publication hands matching budgets'` | 6 passed, 174 filtered |
| `src/lib/mcp/server.test.ts` | 101 passed |
| `bun scripts/privacy-publication-gate.ts --staged --require-known-values` | Exit 0 |
| `git diff --cached --check` | Exit 0 |

Tests used `bun run test <explicit-file>` and the package's 60-second timeout.
Fresh comparisons used `bun scripts/local-gate-tests.ts --base <base>` with
explicit paths. The final comparison of `scripts/gate-runner/client.test.ts`,
`src/app/api/projects/settings/route.test.ts` and `src/lib/mcp/schemaParity.test.ts`
exited 0 with zero new failures and three pre-existing failures: environment
inventory, forum-chat lookup and the create-pipeline schema description.

The separate comparison including `scripts/local-gate.test.ts` also exited 0
with zero new failures. That file remains incomplete on both head and base with
the same between-tests runner error; this is no claim that its full lifecycle
suite passed. Baseline reuse was disabled, so both comparisons sampled fresh
isolated runs. The raw suites named here remain red on their existing sites.

## Original implementation record

The publication repair below supersedes the original hook-test comparison for
the publication environment.

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

## Publication repair

Repair verification completed 2026-10-24 14:06 UTC.

Publication of the accepted `d141f70a286c6ce84692c7f6ac90a3b2d2de6c07`
exposed inherited publication context in test fixtures. The publisher sets
`LLV_GATE_PUSH_HEAD`, lane and stage selectors; `checkEnvironment` retains
gate transport variables, and `isolatedEnvironment` passes them into each
test process. Both the shared hook fixture and the comparator's separate
fixture then inherited the enclosing repository's SHA. Their repositories
have their own commits, so the new production guard refused their hooks
before privacy, types, lint or receipt assertions could run.

The common test preload now clears the enclosing publication's head, lane,
stage and private Cloud configuration. Fixture hooks run their complete local
check plan by default; Cloud tests explicitly choose Cloud execution. Production
hook selection, transport and outgoing-head enforcement are unchanged.

The source repair is identified by SHA-256
`807168713db4968a71168a1f5301afd9f1aa428775078ab6a751eb66580dd8b8`
of `git diff --binary d141f70a286c6ce84692c7f6ac90a3b2d2de6c07 -- test-preload.ts src/lib/testing/testGitIsolation.test.ts`.
Documentation is excluded from that digest.

### Reproduction and regression

All runs use scratch exports, the supplied admission wrapper and isolated
home, configuration, temporary and state roots. Checks execute serially.
The canonical publication environment is constructed with `checkEnvironment`
and `isolatedEnvironment`, then supplied with synthetic enclosing publication
selectors. No live Cloud endpoint or operator state is used.

- On the accepted source, the two Cloud hook cases fail with the enclosing
  SHA. Removing only `LLV_GATE_PUSH_HEAD` makes both pass.
- The unchanged-main hook case passes on base
  `e92a0ddde58e07ec491e64b96b4ca2c722ebab60` and fails on the accepted
  source under the same canonical environment.
- The new regression fails before the preload repair and passes afterwards.
  It starts a real test process with foreign publication selectors and Cloud
  configuration, then runs the real fixture hook. The fixture's own outgoing
  SHA succeeds through privacy. Incorrect checkout SHAs and conflicting push
  input remain decisive refusals, with no further check effects.
- After the repair, `src/lib/testing/testGitIsolation.test.ts` passes all
  eight cases, `scripts/cloud-checks.test.ts` passes all 37, and the
  unchanged-main hook case passes with the enclosing selectors present.

Payloads for those checks are `bun run test <explicit-file>`; the focused
hook case additionally uses
`--test-name-pattern="pre-push hook on a branch behind main"`.

### Paired hook-suite limits

The complete hook files were also run separately on base and repaired source,
with fresh isolation for every file and the same synthetic publication context.

| File | Base pass / fail | Repaired pass / fail |
| --- | ---: | ---: |
| `scripts/local-gate-tests.test.ts` | 66 / 1 | 66 / 1 |
| `scripts/local-gate.receipts.test.ts` | 2 / 6 | 2 / 6 |
| `scripts/local-gate.test.ts` | 60 / 9, one error | 60 / 9, one error |

Failing assertion names match on both sides. Nested hook checks in this stage's
signal namespace refuse inherited CPU slot ownership; the lifecycle sample
also has matching containment and between-tests cleanup failures. A separate
native-service probe refused the caller's PID namespace before executing its
command. No admission or containment guard was disabled to obtain a verdict.
These runs establish the remaining stage-environment limitations and do not
establish a complete native hook-suite pass. The controller's publication runs
the repaired source under its own hook environment.

### Final static and publication checks

The tested export's two source files match the repair checkout byte for byte.
The final compiler command is `bun node_modules/typescript/bin/tsc --noEmit`;
lint is `bun node_modules/eslint/bin/eslint.js test-preload.ts src/lib/testing/testGitIsolation.test.ts`.
Both exit 0 without diagnostics. `git diff --check HEAD` also exits 0.
The privacy gate with committed known-value fingerprints passes on all three
repair files. The repair uses the repository's enabled commit hooks and leaves
the production hooks, lane-settings UI and workflows unchanged.
