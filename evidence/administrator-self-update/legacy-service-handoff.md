The administrator policy now leaves an admitted external deployment's legacy user-service handoff available. `src/lib/selfUpdate/service.ts:1681` invokes the shared private executor. The public `performInstallAction` entry at `src/lib/selfUpdate/service.ts:1700` keeps its administrator refusal before entering that executor. The executor retains the existing launcher, release, quiet-work, trial, drain and service-proof checks.

The public consumer is `postInstallAction` in `src/lib/selfUpdate/routes.ts`, exported by `src/app/api/self-update/action/route.ts` and used by the Updates dialog. Internal applies come from checkout update/retry, external deployment admission and ready-apply recovery. External deployment admission still runs through `deployRevision` and the deployment API's authorization callback. No request field selects the private executor, and no persisted record shape changes.

`src/lib/selfUpdate/routes.test.ts:1328` adds six cases: verified completion, verified rollback and service-manager refusal, with the administrator policy both on and off. They use the real deployment, build/apply, install-action and ledger code, with fixture ports for service discovery and execution. A replacement service reads the persisted apply and drain before settlement. Direct built-in Update, Retry, automatic-setting and install-action calls remain 403 under the policy.

The earlier fixes remain in the branch: accepted operator/seat relaunches retain their drain until verified completion or rollback, and the successor-bootstrap test uses its own baseline checkout. Their cold-process and A-to-B cases are included in the full routes check below.

Integration first uses merge commit `644707db7ed2f3cd12d481dcb5d13424fd18ba81`, incorporating captured main `cb408fce4827a04fe4844575aea117bb08d1db9c`. The implementation commit is `bfd0326b8c54de73195bd587cdc5298a62723fa6`. During the baseline wait main advanced to `15099450d8759bd28662bcccf18bfc1da0d4702b`, changing archived registry view readers and their tests; merge commit `aaa56151a9ff8264960a18f1e195b29a9dc9e685` integrates it. Self-update source and tests remain byte-identical. The final full routes run is renewed after that integration; the comparison base remains the captured main above.

The handoff fetch found one further main commit, `a706416942a261300de13ed78c965cea75c1d202`, bounding engine-host event history and releasing retained host references. Its actual diff changes engine-host, event-store and delivery/startup files and tests; it leaves self-update source, tests, dependencies and configuration unchanged. Merge commit `b7fa69bcda035615c6b1e6e0a3837333e4788518` incorporates it. A fresh scoped acceptance run checks public policy refusals, external service handoff, accepted relaunch custody and the bootstrap/staged-build sequence on that integrated tree. The full-file comparison below retains its exact captured inputs.

That isolated selection exposed a fixture dependency: the four cold-process cases read the target revision from the shared initial checkout, where earlier full-file tests had fetched it. Selected alone, they reached the terminal-write crash fixture and failed with `fatal: bad object`. Commit `c234ddad9e1cd91da73aeb6bc0639b75b9dbca2b` reads the revision from each case's existing private candidate clone instead. This preserves the full-file setup and makes the selected cases independent of earlier fetches. The filtered acceptance and full routes checks are renewed after this one-line test repair.

Tests use tracked scratch exports, identical dependencies and fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR for every invocation. NODE_ENV is `test`; runtime sockets are private and Viewer control URLs name a closed loopback port. The pre-fix control uses the tree at `aaa56151a9ff8264960a18f1e195b29a9dc9e685`, replacing only its service with the version from `644707db7ed2f3cd12d481dcb5d13424fd18ba81`. The captured-main export is unmodified main. The first handoff selection uses `b7fa69bcda035615c6b1e6e0a3837333e4788518`; the repaired acceptance and full-file exports use `c234ddad9e1cd91da73aeb6bc0639b75b9dbca2b`.

Every test row uses the supplied release `2614b079b3f1` wrapper:

```sh
LLV_OWNED_RUN_TIMEOUT_MS=600000 bash "$GATE_WRAPPER" --record "$STAGE_TMP/<run>.log" \
  bash "$RUN" "$RUN_ROOT" "$EXPORT" <command>
```

The retained `legacy-fix/run.sh` prints the command, UTC start/end and actual exit status and supplies the isolation above. Each test recording receives one native `wait_for_check` call through admission, execution and cleanup. CPU-queue waiting is retained in its log.

| Run | Command | Exit | Pass | Fail | Assertions | Filtered |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| focused, before last main merge | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts --test-name-pattern 'external legacy service deployment'` | 0 | 6 | 0 | 70 | 130 |
| full routes, before last main merge | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 134 | 2 | 871 | 0 |
| captured main full routes | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 112 | 2 | 603 | 0 |
| final merged full routes | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 134 | 2 | 871 | 0 |
| predecessor service control | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts --test-name-pattern 'external legacy service deployment'` | 1 | 3 | 3 | 50 | 130 |
| handoff selection, fixture dependency | H | 1 | 15 | 4 | 227 | 117 |
| repaired isolated acceptance | H | 0 | 19 | 0 | 259 | 117 |
| final full routes after fixture repair | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 134 | 2 | 871 | 0 |

The scoped handoff command H is:

```sh
bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts --test-name-pattern 'administrator self-update policy|external legacy service deployment|disabled cold processes|healthy successor bootstrap|legacy staged build'
```

All eight recordings reached terminal cleanup. Their commands, actual exits, mandatory runner counts, UTC clocks, failure identities and log digests were reconciled into the retained `legacy-fix/checks.json`; no incomplete run is counted as passing. The final full-file result has only the same two failures as captured main, and the complete isolated acceptance selection is green.

The predecessor control differs from the fixed export in exactly one file, the service implementation. All three policy-off cases pass. All three policy-on cases fail because the administrator guard prevents the service-manager call: expected one call, observed zero. The identical six tests pass with the fixed service. This control's exit 1 is the expected reproduction of the handed defect.

The first full routes run completed on 2026-11-12 at 13:30:24–13:31:23 UTC. All four accepted operator/seat cold-process cases, the private successor-bootstrap case and the later legacy staged-build custody case pass, alongside the six new service-handoff cases. The final merged run repeats the same counts and the same two failures. Both failures reproduce on captured main: the managed short-revision admission expectation (400 expected, 202 returned) and Retry after a verified rollback (timeout with check up-to-date, update failed and busy null). These remain baseline notes outside the handed findings.

Their full test identities are:

- `managed install: an update is one Viewer deployment > managed installs refuse short revisions before runtime admission`
- `checkout install: a staged build and restarts by the launcher > Retry after a verified rollback rebuilds and sends another complete apply`

| Run | UTC start–end on 2026-11-12 |
| --- | --- |
| focused, before last main merge | 13:18:54–13:19:02 |
| full routes, before last main merge | 13:30:24–13:31:23 |
| captured main full routes | 13:47:50–13:48:22 |
| final merged full routes | 14:02:36–14:03:41 |
| predecessor service control | 14:15:00–14:15:06 |
| handoff selection, fixture dependency | 14:28:50–14:29:06 |
| repaired isolated acceptance | 14:42:43–14:43:10 |
| final full routes after fixture repair | 14:53:41–14:54:59 |

Focused lint ran `bun node_modules/eslint/bin/eslint.js src/lib/selfUpdate/service.ts src/lib/selfUpdate/routes.test.ts`: both initial and final-source runs exit 0, two files, zero errors and zero warnings. The final lint ran at 14:32:46–14:32:52 UTC. Both plain implementation/fixture `git commit` commands ran the repository hooks: staged whitespace and changed-file ESLint passed, with zero introduced errors. Publication privacy ran `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --added-lines --base cb408fce4827a04fe4844575aea117bb08d1db9c`: exit 0, PASS, zero findings.

`git diff --check` exits 0 with zero whitespace errors. `git merge-base --is-ancestor 15099450d8759bd28662bcccf18bfc1da0d4702b HEAD` exits 0 and proves that integrated main is an ancestor. `diff -qr --exclude=node_modules "$FINAL_EXPORT" "$PRE_FIX_EXPORT"` exits 1 as expected and reports exactly one differing file, `src/lib/selfUpdate/service.ts`; here FINAL_EXPORT denotes the full-file export at `aaa56151a9ff8264960a18f1e195b29a9dc9e685`.

The final fetch found no movement beyond `a706416942a261300de13ed78c965cea75c1d202`; `git merge-base --is-ancestor a706416942a261300de13ed78c965cea75c1d202 HEAD` exits 0. The source hashes below match the final export. Whole-file privacy runs `bun scripts/privacy-publication-gate.ts --repository . --require-known-values --paths evidence/administrator-self-update/legacy-service-handoff.md "$STAGE_REPORT"`: exit 0, PASS, two files and zero findings. The final committed-range check runs `bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --added-lines --base a706416942a261300de13ed78c965cea75c1d202`: exit 0, PASS, zero findings. Their retained logs are `legacy-fix/report-privacy.log` and `legacy-fix/publication-privacy-final.log`.

No full typecheck, build or repository-wide test campaign runs in this fix stage. Publication owns its full gate. Earlier evidence files remain historical records for their stated inputs.

Final implementation SHA-256:

| File | Digest |
| --- | --- |
| `src/lib/selfUpdate/service.ts` | `bdb44caa7c379bb7acee6803e1a1a94b0fc8cd7a44f4ffc880af1e0b2c47b6e1` |
| `src/lib/selfUpdate/routes.test.ts` | `5a91afac552c2b85c4db3e45fe16c2f291fb66e534dcc35a65e32cf0340a7c03` |
