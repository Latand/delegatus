Run the setting by adding `DELEGATUS_DISABLE_SELF_UPDATE=1` to the environment that starts Delegatus and restarting it. Remove it and restart to restore the saved automatic-update preference. The default stays unchanged.

The server returns HTTP 403 / `updates-disabled` for built-in update, retry, install-action and automatic-update setting/decision requests. The dialog shows the administrator policy in English or Ukrainian. Previously admitted automatic transactions retain custody through completion; an unadmitted waiting hold is released. Package-manager updates, checkout pull/build commands and the deployment control API remain available.

Verification ran on 2026-11-12 using Bun 1.4.0. The starting main revision is `c39bd873b1`. `source-digests.json` identifies the final feature source and tests; `rendered.json` identifies the captured UI source. Every test ran by explicit file path in a scratch export. Each invocation used a fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, NODE_ENV=test, a private runtime-host socket and a closed Viewer control port. No live installation was exercised.

Each test command below was invoked as `bash "$GATE_WRAPPER" --record "$STAGE_TMP/<run>.log" bash "$RUN" <run> <command>`. `GATE_WRAPPER` was the pipeline-supplied gate-slot.sh at release `34b741354731`; `RUN` was the scratch helper that set the isolated environment, ran the exact command and printed ACTUAL_EXIT_STATUS. The execution allowance was 600000 ms. Each recorder received one wait_for_check call through terminal command cleanup. Raw logs and receipts are retained in this stage’s evidence directory under `checks/`; private paths in those logs are excluded from this published record.

| Run | Command inside isolated gate | Exit | Pass | Fail | Assertions |
| --- | --- | ---: | ---: | ---: | ---: |
| `routes-1` | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 123 | 2 | 674 |
| `routes-base-1` | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 112 | 2 | 603 |
| `dom-1` | `bun test --timeout=60000 src/components/selfUpdate/SelfUpdateView.dom.test.tsx` | 0 | 148 | 0 | 639 |
| `browser-1` | `bun test --timeout=240000 src/components/kanban/kanbanBoard.browser.test.tsx --test-name-pattern 'administrator self-update policy'` | 0 | 1 | 0 | 56 |
| `routes-2` | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 123 | 2 | 674 |
| `auto-1` | `bun test --timeout=60000 src/lib/selfUpdate/auto.test.ts` | 1 | 100 | 6 | 672 |
| `auto-base-1` | `bun test --timeout=60000 src/lib/selfUpdate/auto.test.ts` | 1 | 100 | 6 | 672 |
| `auto-2` | `bun test --timeout=60000 src/lib/selfUpdate/auto.test.ts` | 1 | 100 | 9 | 700 |
| `managed-auto-1` | `bun test --timeout=60000 src/lib/selfUpdate/managedAuto.test.ts` | 0 | 98 | 0 | 544 |
| `auto-3` | `bun test --timeout=60000 src/lib/selfUpdate/auto.test.ts` | 1 | 103 | 6 | 700 |
| `policy-final` | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts --test-name-pattern 'administrator self-update policy\|disabled built-in updates\|checkout exact deploy'` | 0 | 13 | 0 | 85 |

The browser run also set LLV_KANBAN_BROWSER_TEST=1 and CHROME_BIN to the installed Chromium executable. It selected one existing driver case, filtered out 306 unrelated cases, and produced eight frames: 390×844 and 1440×700, English/Ukrainian, light/dark. All eight frames were visually inspected. Text-range measurements against clipping ancestors on opening, PageDown and final observation found complete notice text, no heading/body overlap and no horizontal overflow. See `rendered.json`.

The final focused route run filtered out 112 unrelated cases and passed all 13 acceptance cases. These include twelve valid HTTP mutation requests refused across the two environment spellings, defaults and precedence, two real disabled service processes followed by a re-enabled process reading the same persisted preference, prepared update recovery, and external deployments with the policy both on and off. A command-line package installation was not changed by verification; its package-manager path has no dependency on the new Viewer setting.

The two route failures are pre-existing: “managed installs refuse short revisions before runtime admission” and “Retry after a verified rollback rebuilds and sends another complete apply”. Both reproduce in `routes-base-1` with matching isolation.

The six automatic-controller failures also reproduce in `auto-base-1`: final launcher admission after its Git observation for accepted-disable, manual-build, snapshot-build and quiet-build; the delayed Git observation / older switch case; and the web fallback pointer / switch case. Final `auto-3` adds three passing policy cases with no new failures. `auto-2` additionally had three incorrect assertions against a fixture’s stubbed snapshot; those assertions were corrected to check real service refusals, and `auto-3` confirms the fix. The initial runs and all corrections are retained above.

DOM verification passed all 148 cases, including eight new policy cases across all four installation modes and both languages. Managed automatic-update verification passed all 98 cases. Default automatic-update behavior retains the same observed baseline failures as main.

Whitespace checks: four direct `git diff --check` invocations during implementation and review each exited 0 with zero whitespace errors. Final publication and commit-hook results are also recorded in the stage handover. Full typecheck, build and full-repository tests are left to the pipeline’s publication hooks, as required by the stage’s scope rules.

| Additional check | Command | Exit | Counts |
| --- | --- | ---: | --- |
| `lint-1` (unfiltered after shell file-list preparation failed) | `bun run lint` | 1 | 425 errors, 422 warnings; 847 diagnostics. File count was not reported. |
| `lint-2` (explicit changed files) | `bun run lint src/components/kanban/kanbanBoard.browser.test.tsx src/components/selfUpdate/SelfUpdateView.dom.test.tsx src/components/selfUpdate/SelfUpdateView.tsx src/lib/i18n/en.ts src/lib/i18n/uk.ts src/lib/selfUpdate/auto.test.ts src/lib/selfUpdate/auto.ts src/lib/selfUpdate/managedAuto.test.ts src/lib/selfUpdate/routes.test.ts src/lib/selfUpdate/service.ts src/lib/selfUpdate/types.ts src/lib/selfUpdate/__fixtures__/installationPolicy.child.ts` | 0 | 12 files; 0 errors, 6 warnings. |
| `privacy-1` | `bun scripts/privacy-publication-gate.ts --repository . --require-known-values --paths docs/guide/configuration.md src/components/kanban/kanbanBoard.browser.test.tsx src/components/selfUpdate/SelfUpdateView.dom.test.tsx src/components/selfUpdate/SelfUpdateView.tsx src/lib/i18n/en.ts src/lib/i18n/uk.ts src/lib/selfUpdate/auto.test.ts src/lib/selfUpdate/auto.ts src/lib/selfUpdate/managedAuto.test.ts src/lib/selfUpdate/routes.test.ts src/lib/selfUpdate/service.ts src/lib/selfUpdate/types.ts evidence/administrator-self-update/checks.md evidence/administrator-self-update/rendered.json evidence/administrator-self-update/source-digests.json src/lib/selfUpdate/__fixtures__/installationPolicy.child.ts` | 0 | 16 changed files; PASS, no findings. |

The unfiltered lint invocation is retained as an unsuccessful check. Its full-project diagnostics were not assigned a cause or compared against main; the scope of this stage is the changed files, whose explicit lint passes. No product source changed after the final acceptance and controller checks. The repository’s pre-commit hook and a final privacy scan of this completed record and commit text are reported by the stage handover.

Recorded test wrappers reached terminal completion between 2026-11-12T07:01:06Z and 2026-11-12T07:15:18Z. The privacy scan completed at 2026-11-12T07:22:42Z.

`privacy-2`: `bun scripts/privacy-publication-gate.ts --repository . --require-known-values --paths evidence/administrator-self-update/checks.md publication-commit-message.txt` exited 1: one email-address finding in the machine attribution trailer because a prospective commit message was scanned as ordinary prose. The required attribution trailers are preserved. The completed report is scanned separately, and the actual commit receives the gate’s commit-specific trailer review through --check-commits; those final results are in the stage handover.
