Eight regression pins were retained from the Codex Cloud drafts. The source snapshot is main at `95d52f4db9803e9a06d835fb5dbe37bbbd4d2b79`; verification ran on 2026-10-23 with Bun 1.4.0. All ten supplied diffs applied with `git apply` (exit 0 each).

All test and typecheck commands ran through `gate-remote`, the repository `scripts/gate-slot.sh`, and the unchanged `bunfig.toml` owned-runner preload. HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR were isolated, and the Delegatus control URL used a closed port. Inner commands used `setsid` and stdin from `/dev/null`. Commands ran sequentially. Source reversals happened only in isolated runner exports; each source file was restored and compared byte for byte before continuing.

In the table, each displayed `bun test` command uses `--timeout=60000`. The reversal column reruns its added case with `--test-name-pattern` after reversing the fixing hunk below. Exit 1 in that column is the expected regression failure. The initial and latest columns give whole-file command exits.

| Issue | Decision | Command, under the wrapper above | Initial full file | Latest full file | Reversed fix, added case |
| --- | --- | --- | ---: | ---: | ---: |
| #3167 | dropped | `bun test --timeout=60000 src/lib/runtime/claudeStreamBrokerHost.test.ts` | 0 | dropped | 0 |
| #3163 | kept | `bun test --timeout=60000 src/lib/pipelines/stageAttemptPush.test.ts` | 0 | 0 | 1 |
| #3066 | kept | `bun test --timeout=60000 src/lib/pipelines/engine.recovery.test.ts` | 0 | 0 | 1 |
| #3031 | kept | `bun test --timeout=60000 src/lib/pipelines/startupResponsiveness.test.ts` | 0 | 0 | 1 |
| #2975 | kept | `bun test --timeout=60000 src/app/api/voice-companion/calls/route.test.ts` | 0 | 0 | 1 |
| #2972 | kept | `bun test --timeout=60000 src/lib/voiceCompanion/liveSession.test.ts` | 1 | 0 | 1 |
| #2971 | kept | `bun test --timeout=60000 src/lib/voiceCompanion/ownerHistoryRead.test.ts` | 0 | 0 | 1 |
| #2461 | dropped | `bun test --timeout=60000 src/runtime-host/journal.consumerRetention.test.ts` | 0 | dropped | not applicable |
| #2401 | kept | `bun test --timeout=60000 src/lib/pipelines/engine.recoveryAdmission.test.ts` | 0 | 0 | 1 |
| #2391 | kept | `bun test --timeout=60000 scripts/privacy-publication-gate.test.ts` | 1 | 1 | 1 |

#3167 was dropped because its test using a restricted sandbox still passed when the pipeline scratch extension was reversed (`src/lib/runtime/structuredSpawn.ts:188`). It misses the affected path with a full sandbox. Its diff was removed with `git apply -R` (exit 0).

#2461 was dropped because the issue remains unfixed. With a retention target of two events, the draft accepted 25 retained events and 24 completion checkpoints behind a permanently deferred cursor. It accepts retained growth and omits the requested bounded recovery or quarantine policy (`src/runtime-host/journal.ts:2285`). No relevant fixing hunk exists to reverse. Its diff was removed with `git apply -R` (exit 0).

The retained drafts gained three small refinements: #2975 uses an injected clock and checks the action timestamp; #2971 uses a fixed clock and closes its own relay fixture; #3066 checks the first retry schedule before advancing its clock. The first #3066 reversal exposed a missing schedule through an invalid clock advance (exit 1). After the explicit schedule assertion was added, the reversal failed directly on the missing retry (exit 1), and the added case passed on restored code (exit 0).

| Issue | Existing fix | Reversed code, then restored |
| --- | --- | --- |
| #3167 | `806f04af5` | Restore the old `if (!restricted)` early return at `src/lib/runtime/structuredSpawn.ts:188`. The draft survives. |
| #3163 | `0e2cfa007` | Remove the loop over previous attempt receipts at `src/lib/pipelines/stageAttemptPush.ts:209`. Settlement refuses the inherited commit. |
| #3066 | `63daa209c` | Remove callback listener retry classification at `src/lib/pipelines/engine.ts:10568`. The first retry is absent. |
| #3031 | `d97a20c54` | Move cache assignment after the freshness check at `src/lib/pipelines/store.ts:1299`. The second read decodes 49 rows; its expected count is one. |
| #2975 | `2a609ac9a` | Remove projection of request entries at `src/lib/voiceCompanion/callHistoryTypes.ts:68`. The stored failed action disappears. |
| #2972 | `99a4091b1` | Remove the `inputPending` hold at `src/lib/voiceCompanion/liveSession.ts:846`. The report is spoken during unfinished input. |
| #2971 | `a880de287` | Remove HTTP 504 classification at `src/lib/externalRelay/ownerHistory.ts:138`. The response becomes generic HTTP error speech. |
| #2401 | `665f21c343` | Remove settlement of parked reports before recovery at `src/lib/pipelines/engine.ts:11900`. The attempt keeps running with no settled verdict. |
| #2391 | `e30d313284` | Remove the compound catalog entry's exactOnly flag at `scripts/privacy-known-value-fingerprints.json:13`. Ordinary prose is refused. |

Every source hunk applied with `git apply -` (exit 0): nine in the initial reversal matrix and one final #3066 recheck. The matrix ended with nine expected outcomes and nine verified source restorations.

The two initial whole-file failures were compared with the unmodified test files from the source snapshot, in the same export and isolation. The voice file initially timed out in its existing 800-fragment case; the unchanged file reproduced that timeout. Its final run passed all 128 cases. The privacy file has 20 failures, all observed among 21 failures on the unchanged file: 15 OCR/media cases need missing tesseract, two generator fixtures fail, and three CPU growth cases exceed existing bounds. The unchanged file additionally failed the double quote CPU growth case. There are zero candidate-only failures in the paired privacy comparison. The added #2391 case passes.

| Comparison command, under the same wrapper | Unchanged source exit | Final candidate exit |
| --- | ---: | ---: |
| `bun test --timeout=60000 src/lib/voiceCompanion/liveSession.test.ts` | 1 | 0 |
| `bun test --timeout=60000 scripts/privacy-publication-gate.test.ts` | 1 | 1, all failures also seen on unchanged source |

| Additional command | Exit |
| --- | ---: |
| `gh issue view "$n" --json number,title,body,state,closedAt`, for each of the ten issues | 0 each |
| `git apply "$CLOUD_DIFF_DIR/cloud-${n}.diff"`, for each of the ten supplied drafts | 0 each |
| `git apply -R "$CLOUD_DIFF_DIR/cloud-2461.diff"` | 0 |
| `git apply -R "$CLOUD_DIFF_DIR/cloud-3167.diff"` | 0 |
| `bun test --timeout=60000 src/lib/voiceCompanion/liveSession.test.ts --test-name-pattern 'an unfinished operator utterance keeps a newly due report unhanded'`, through gate-remote and gate-slot | 0 |
| `bun test --timeout=60000 scripts/privacy-publication-gate.test.ts --test-name-pattern 'the committed catalog distinguishes open-source prose from its configured value'`, through gate-remote and gate-slot | 0 |
| `bunx tsc --noEmit --incremental false`, through gate-remote and gate-slot, including final test edits | 0 in both runs |
| `bun run privacy:check`, local publication preflight | 0 |
| `bun install --cwd "$OWNED_DEPENDENCIES" --frozen-lockfile --ignore-scripts`, scratch dependencies for commit hooks | 0 |
| `git commit --file "$MESSAGE_FILE"`, eight test pins with repository hooks active | 0 |
| `git fetch origin main`, scope rechecks | 0 each |
| Initial gate-remote full-file campaign, ten files, final ran-count 10 | 1, two whole-file failures recorded above |
| gate-remote reversal and baseline campaign, nine reversals and five final checks | 1, privacy whole-file baseline failures |
| Callback assertion, focused positive checks and typecheck campaign, final ran-count 5 | 1, two existing spawn-budget assertions in its whole-file callback run |
| Final callback whole-file base/head comparison and focused positive check | 0, accepted full-file comparison |

The supplied promotion directory is represented by `$CLOUD_DIFF_DIR`; `$n` is the issue number. All test paths above are relative to the repository. Test commands kept the owned-runner preload, and the test-pin commit used repository hooks.

Open overlapping diffs were read before applying the drafts: #3276, #3269, #3260, #3253, #3236, #3212 and #3207. Their changes were kept outside this batch. Main was rechecked through `adce5764927f7e838f20070cd2968128912e861c`; the candidate test paths and reversed fixing code were unchanged from the source snapshot.

The retained cases are located at:

| Issue | Test location |
| --- | --- |
| #3163 | `src/lib/pipelines/stageAttemptPush.test.ts:580` |
| #3066 | `src/lib/pipelines/engine.recovery.test.ts:311` |
| #3031 | `src/lib/pipelines/startupResponsiveness.test.ts:697` |
| #2975 | `src/app/api/voice-companion/calls/route.test.ts:56` |
| #2972 | `src/lib/voiceCompanion/liveSession.test.ts:2286` |
| #2971 | `src/lib/voiceCompanion/ownerHistoryRead.test.ts:20` |
| #2401 | `src/lib/pipelines/engine.recoveryAdmission.test.ts:310` |
| #2391 | `scripts/privacy-publication-gate.test.ts:2586` |

The intermediate callback full-file rerun returned 1 in the existing tests for an uncertain send and adoption of a working agent. Its added case passed. The subsequent observations below preserve every full-file outcome; each command uses `bun test --timeout=60000 src/lib/pipelines/engine.recovery.test.ts` under the same wrapper. The unchanged file had 66 passes and 17 skips; the final file had 67 passes and the same 17 skips. The added case executed and passed. The last focused command adds `--test-name-pattern` with the #3066 case name.

| Callback comparison observation | Exit | Failed cases |
| --- | ---: | --- |
| base-1 | 0 | none |
| head-1 | 0 | none |
| pin | 0 | none |

PR reference lines:

- Refs #3163 — already fixed on main, pinned
- Refs #3066 — already fixed on main, pinned
- Refs #3031 — already fixed on main, pinned
- Refs #2975 — already fixed on main, pinned
- Refs #2972 — already fixed on main, pinned
- Refs #2971 — already fixed on main, pinned
- Refs #2401 — already fixed on main, pinned
- Refs #2391 — already fixed on main, pinned
