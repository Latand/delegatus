# Codex Cloud fixes: promotion verification

Fixes #2378
Fixes #2357

The first drafts came from Codex Cloud. Both retained patches were applied with `git apply`, then checked against the originating issues and extended locally. The duplicate #3250 patch was dropped after reviewing PR #3253. No issue comments or workflow edits were made. Publication belongs to the pipeline.

Implementation base: `adce57649`, fetched from main after the assigned starting revision. Verification date: 2026-10-23 UTC.

The implementation source fingerprint, excluding this report, is `65856c0aab3c3074871d0bee4b1415c67f220d8fc66807ff72b3a47b48adf3a3`. Reproduce it with:

```sh
git diff --name-only adce57649 -- src/ | LC_ALL=C sort | xargs sha256sum | sha256sum
```

## Decisions and fixes

| Issue | Decision | Implementation | Revert check |
| --- | --- | --- | --- |
| #3250 | Dropped | PR #3253 already resolves and fetches the missing candidate base, uses the merge base, verifies recovered shallow history, and preserves file, message and identity checks. Its regression cases cover clean and violating behind branches and unavailable objects. | Not applicable: no duplicate implementation or test was applied. |
| #2378 | Kept | `src/lib/links/agentFeed.ts:82` lazily indexes persisted attempts by conversation ID and agent path once per immutable pipeline snapshot; explicit registry memberships skip the fallback index. Rows without registry membership recover their task, stage, pipeline and attempt state. Explicit registry membership retains precedence. | Restoring only the production file to the base makes all three new lookup cases fail. An unrelated conversation remains unattributed. |
| #2357 | Kept and completed | Question metadata travels from the broker through `src/lib/runtime/registry.ts:93` and the registry reader into liveness and compact MCP activity. It includes the transcript tool-use ID needed for an answer. Option numbering follows the transcript question card. The integration case rejects a stale answer, then answers the exact question through MCP, HTTP, the runtime journal and broker; the held turn ends and pending metadata clears. | Reverting the production fix makes the new liveness, broker and MCP integration cases fail. The parser file fails to import the removed exports. Reverting only the serializer also fails the registry-reload assertion. |

The shared question path was traced through `ClaudeStreamBrokerHost.currentState`, `claudeHostColumns`, `normalizeStructuredHost`, `agentLivenessSnapshot` and `compactLiveness`. The existing answer path uses `pendingToolUses`, `answerNativeRequest`, the runtime journal and `host.answer`. The existing launcher notice uses scanner questions, attention routing and the seat agenda; `src/lib/attention/routing.test.ts:79` verifies its question, options and exact answer target. The initial promotion checks made no speed or memory claim; follow-up refresh measurements appear below.

Open overlapping diffs were inspected for PRs #3253, #3269, #3263, #3260, #3242, #3241, #3236, #3212, #3200 and #2926. The retained edits avoid their unrelated schema, startup, account selection and process ownership changes. A final main refresh found no movement from the implementation base.

## Commands and exits

Issue reads used `gh issue view N --comments --json number,title,body,comments` for each of 3250, 2378 and 2357: exit 0. Plain `gh issue view N --comments` first returned exit 1 because the installed CLI queried a retired project field; the explicit JSON reads succeeded. `gh pr diff 3253`: exit 0. The initial PR metadata request used an unsupported field and exited 1; the corrected request exited 0.

| Preparation command | Exit |
| --- | --- |
| `git fetch origin main` | 0 |
| `git merge --ff-only origin/main` | 0 |
| `git apply --check $HOME/.local/state/delegatus-promotion/cloud-2378.diff` | 0 |
| `git apply $HOME/.local/state/delegatus-promotion/cloud-2378.diff` | 0 |
| `git apply --check $HOME/.local/state/delegatus-promotion/cloud-2357.diff` | 0 |
| `git apply $HOME/.local/state/delegatus-promotion/cloud-2357.diff` | 0 |
| `bun install --frozen-lockfile` | 0 |

All test commands used the normal Bun configuration and its owned-runner preload. Tests ran on the gate runner. Each full-file observation below ran as a separate `setsid bun test FILE </dev/null` process inside a sequential `gate-remote -- bash -c ...` call. Each file received fresh HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR and LLV_STATE_DIR directories. The harness printed an exit for every file and a final ran-count; all 14 files completed. Files changed after that campaign were rerun separately; all three completed. The parser file was also rerun after its type-only and formatting corrections.

| Executed test command inside the remote harness | Final exit | Result |
| --- | --- | --- |
| `bun test src/lib/links/agentFeed.test.ts` | 0 | 20 passed |
| `bun test src/lib/links/laneFeed.test.ts` | 0 | 9 passed |
| `bun test src/lib/links/runtimeState.test.ts` | 1 | Assertion passed; existing owned-child teardown failure also reproduced on base |
| `bun test src/lib/memory/privacy.test.ts` | 0 | 9 passed |
| `bun test src/lib/memory/roleEgress.test.ts` | 0 | 9 passed |
| `bun test src/lib/mcp/linkedSeatTools.test.ts` | 1 | 4 passed; existing privacy-store spy assertion also failed on base |
| `bun test src/lib/lifecycle/liveness.test.ts` | 0 | 194 passed |
| `bun test src/lib/runtime/claudeStreamBrokerHost.test.ts` | 0 | 141 passed |
| `bun test src/lib/runtime/permissionRequests.test.ts` | 0 | 3 passed |
| `bun test src/lib/runtime/structuredControls.test.ts` | 0 | 73 passed, including stale and unbound answer refusals |
| `bun test src/lib/mcp/compactAnswers.test.ts` | 0 | 12 passed |
| `bun test src/lib/mcp/conversationAction.integration.test.ts` | 0 | 8 passed |
| `bun test src/lib/mcp/server.test.ts` | 0 | 101 passed |
| `bun test src/lib/attention/routing.test.ts` | 0 | 13 passed |

The initial combined command `gate-remote -- bun test src/lib/links/agentFeed.test.ts src/lib/links/laneFeed.test.ts src/lib/links/runtimeState.test.ts src/lib/memory/privacy.test.ts src/lib/memory/roleEgress.test.ts src/lib/mcp/linkedSeatTools.test.ts` exited 1. Repeating that same six-file command on the base also exited 1 with the same pre-existing failures; the additional new lookup test also encountered the shared state cleanup failure. Separate processes remove that cross-file contamination. The two remaining individual-file failures above were each rerun on the base with identical isolation: each exited 1 at the same site. Neither is attributed to these fixes or changed here.

Focused MCP integration development commands used `gate-remote -- bun test src/lib/mcp/conversationAction.integration.test.ts --test-name-pattern 'MCP answer reaches'`. The first exited 1 because the synthetic transcript was outside scanner roots. The next exited 1 because the simulated provider was absent from native process discovery. The fixture now supplies only its owned process identity to the real transcript question reader. The next focused run and the final complete-file runs exited 0.

All removal probes ran only in disposable remote checkouts, preserving the new tests. No revert was committed. Each production restore command below exited 0.

| Removal and executed regression command | Exit |
| --- | --- |
| Restore `src/lib/links/agentFeed.ts` from `adce57649`; `bun test src/lib/links/agentFeed.test.ts --test-name-pattern 'raw scan snapshot rows recover'` | 1: all 3 cases failed |
| Restore #2357 production files from `adce57649`; `bun test src/lib/lifecycle/liveness.test.ts --test-name-pattern 'structured AskUserQuestion'` | 1 |
| Same restored production; `bun test src/lib/runtime/claudeStreamBrokerHost.test.ts --test-name-pattern 'reports pending permission requests'` | 1 |
| Same restored production; `bun test src/lib/runtime/permissionRequests.test.ts --test-name-pattern '.'` | 1: removed exports |
| Same restored production; `bun test src/lib/mcp/conversationAction.integration.test.ts --test-name-pattern 'MCP answer reaches'` | 1 |
| Restore only `src/lib/runtime/registry.ts` from `adce57649`; `bun test src/lib/runtime/claudeStreamBrokerHost.test.ts --test-name-pattern 'reports pending permission requests'` | 1: question metadata lost on reload |

| Final check | Exit |
| --- | --- |
| `gate-remote -- bun x tsc --noEmit` | 0 |
| `gate-remote -- bun x eslint` with the explicit files below | 0 |
| Publication scan with committed fingerprints, `--require-known-values --check-commits --base adce57649` | 0 |
| Report publication scan with committed fingerprints and `--paths evidence/cloud-promotion-verification.md` | 0 |
| `git diff --check` and staged whitespace check | 0 |
| `git commit` for #2378, hooks enabled | 0; whitespace, privacy and ESLint passed |
| `git commit` for #2357, hooks enabled | 0; whitespace, privacy and ESLint passed |
| Final `git status --short` and workflow diff | 0; clean checkout, no workflow changes |

The explicit ESLint command is:

```sh
gate-remote -- bun x eslint src/lib/links/agentFeed.ts src/lib/links/agentFeed.test.ts src/lib/agent/registry.ts src/lib/lifecycle/liveness.ts src/lib/lifecycle/liveness.test.ts src/lib/mcp/compactAnswers.ts src/lib/mcp/conversationAction.integration.test.ts src/lib/mcp/server.ts src/lib/runtime/claudeStreamBrokerHost.ts src/lib/runtime/claudeStreamBrokerHost.test.ts src/lib/runtime/engineHost.ts src/lib/runtime/permissionRequests.ts src/lib/runtime/permissionRequests.test.ts src/lib/runtime/registry.ts
```

An initial typecheck exited 2 because the new parser test retained a nullable type after its exact-value assertion; the test now narrows that value. The first working-tree privacy scan exited 1 on a synthetic fixture property at the start of a line; its formatting was corrected without bypassing the gate. The final checks passed after those corrections. Both implementation commits used the repository hooks. No push was run.

## History traversal follow-up

The review identified a repeated full-history traversal in the retained #2378 fix. `src/lib/links/agentFeed.ts` now keeps one lazily built attempt index per feed, clears it when the immutable pipeline array changes, and skips fallback lookup for rows with explicit registry memberships. The list store's revision cache supplies that immutable array. Dropping the feed releases its index.

`src/lib/links/agentFeed.history.test.ts` adds two deterministic checks over 500 pipelines with 100 retained attempts each. Membership-only refreshes read none of the 400 unrelated runs, including the first refresh. A fallback lookup reads those runs once, reuses its index for scan-only changes, rebuilds after a pipeline snapshot replacement, drops removed attribution, and recovers after pipelines return. Both checks fail against the production file from `b8c2e983d`; the existing history case passes there. All three raw-scan attribution cases remain covered by `src/lib/links/agentFeed.test.ts`.

The remote CPU queue stalled, so follow-up checks used the owned gate wrapper locally in scratch exports with private HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR and LLV_STATE_DIR. The normal Bun preload stayed enabled. The completed run before interruption passed `bun test --timeout=60000 src/lib/links/agentFeed.history.test.ts` (3 tests), `bun test --timeout=60000 src/lib/links/agentFeed.test.ts` (20 tests), `bun x tsc --noEmit --incremental false` and ESLint on the two changed feed files and the attribution test file. The continuation recovered the full completed output and confirmed unchanged source, then cancelled its redundant rerun while still waiting for CPU admission. The final publication privacy scan, including commit checks and the updated report, passed. A fresh main fetch found no changes to either edited feed file since the implementation base.

A separate benchmark used ordinary frozen records with no instrumented getters: 500 pipelines, 100 attempts per pipeline, 100 active scan rows with explicit memberships, and 50 published rows. Each process warmed the feed once, retained the same pipeline array, replaced only the scan array for 20 refreshes, and reported the median. Three separate paired local Bun 1.4.0 process comparisons measured pre-fix/fixed medians of 32.943/0.522 ms, 36.938/0.599 ms and 30.852/0.534 ms. The pre-fix source was `b8c2e983d`; the fixed source matches the source fingerprint above. Getter-based traversal assertions are separate from these timing measurements.

Review also established that the compact-answer acknowledgement size assertion is pre-existing: `src/lib/mcp/compactAnswers.test.ts:167` returns 1728 bytes against a limit below 1600 on both `adce57649` and the reviewed change, with the other 11 tests passing. This paired local observation supersedes the earlier remote all-green observation for that file; no compact-answer size fix is included.
