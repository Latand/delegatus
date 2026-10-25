Codex Cloud result 08 adds preparation within slice 3 of `docs/design/proactive-autonomy.md:9`. Unadopted proactive tasks remain fenced, including inside an enabled episode. The change enables no automatic starts. Explicit operator adoption transfers retained work to ordinary authority while preserving allowance and rejection history.

The patch SHA256 is `037d1b665bfd78767abf3166055e0488597379cfa56dfecd05ae353645447719`. It matched its manifest entry before application; the report digest and patch byte count also matched.

The change adds durable operator rejection/adoption, compares scope and decision revisions inside the existing transaction, and guards launch, recovery, delivery, publication and merge. It retains confirmed receipts for effects already in flight. Shared membership checks preserve parent/reviewer provenance, and deletion refuses to discard proactive task records. A gate scanner fix retains JSON and interpreter bytes in publication fingerprints; fresh-process tests verify invalidation.

Removed the unused starts-enabled constant and the guard on the update-branch path that main deleted. Live eligibility, one-lane reservation, fresh account reserve, frozen scope-review grants and the full off/expiry/seat-change rehearsal remain deferred, along with discovery, prompts, UI and live enablement. Full slice 3 remains pending.

Lane `2d925f35` produced a capability proposal with no implementation diff and no PR. It supplied no duplicated proactive code to remove.

Verification used baseline `f348d75bd0012871867ebc63908a69b7b9e65b1c`, isolated state for each file, the pinned gate wrapper and one remote invocation at a time. The primary comparison recorded 421 matching failures and 13 branch-only assertions in `src/lib/runtime/structuredSpawn.integration.test.ts`. All 142 cases in that file passed in three later whole-file runs on each cut with the existing memory guard enabled. Two account-withdrawal stderr assertions remained asymmetric across six runs per cut: each passed 6/6 on main and 5/6 on the branch; both underlying operations exited 0 and emitted schema timing diagnostics at 50.536 ms and 55.235 ms. These observations remain in the evidence. All 21 new preparation cases passed. The existing default-autonomy, episode-settings and durable-allowance suites passed on both cuts.

| Command group | Exit | Result |
| --- | --- | --- |
| Manifest digest and byte verification | 0 | Matched before application and on recheck |
| `git apply --check`, then `git apply` | 0, 0 | Applied the verified export |
| `bun run privacy:check` | 0 | Source and public evidence privacy checks passed |
| `bun x tsc --noEmit --incremental false` | 0 | Final typecheck |
| `bun x eslint <23 touched TypeScript files>` | 0 | 0 errors; 10 unused-variable warnings on declarations unchanged from main |
| Full selected files on main | 1 | 232 file commands: 174 passed, 58 failed; 231 completed, one bootstrap collection failure |
| Full selected files on branch | 1 | 234 file commands: 175 passed, 59 failed; 233 completed, the same bootstrap collection failure |
| Whole-file timing controls | 1 / 1 | All 9 file repetitions completed on each cut; structured spawn passed 3/3 each. Separate account-file runs completed 3/3 each, with aggregate exit 1 on each cut |
| Separate bootstrap diagnostic | 0 / 0 | 5/5 cases passed on each cut under a private empty-preload config; standard failure retained |
| Latest-main three changed Bun test files | 0 / 0 | All passed on both cuts |
| Latest-main landing runtime install and `node --test landing/runtime-tests/access.workerd.mjs` | 0 / 0 | Install succeeded and 11/11 runtime cases passed on both cuts |
| Focused preparation, route, linked-task and ordinary-task files | 1 | Per-file exits 0, 0, 1, 0; the linked file retains the same two index-count assertions on both cuts |
| `git diff --check` and workflow diff | 0, 0 | Clean; no authored workflow changes |
| Ordinary source commits with repository hooks | 0 | All six source/integration commits passed hooks |

`evidence/proactive-autonomy/dispatch-preparation.json` records each explicit file command and exit code, failures, comparison keys, source digests, run timestamps, diagnostic conditions and earlier superseded runs. The standard bootstrap failure remains visible. Current main `62235181a310ad5783cb0fc0342721772efa7b54` was then integrated. All 23 prior source/test hashes remain identical. The three tests changed by that advance and all 11 landing runtime cases passed on both current main and the integrated branch. Privacy, typecheck and touched-file ESLint passed again on the merged tree. The full 232/234-file campaign remains pinned to its recorded earlier revisions.

The authority fix round is recorded in `evidence/proactive-autonomy/authority-fixes.md` and its paired JSON ledger. It binds adoption to accepted scope, preserves detached review-subject authority through recovery, and rechecks merge authority after credential waits.
