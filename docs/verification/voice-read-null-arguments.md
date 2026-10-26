# Voice read argument recovery verification

## Revalidation, 2026-10-26

The assigned baseline, `0728b67c411f29e65b446cf6f4fd591a0c0bb819`, already
contains the fix merged in #3284 on 2026-10-25. The implementation and its
regression tests are unchanged in this stage.

`withoutUnlistedNulls` in `src/lib/voiceCompanion/readSchemas.ts` removes
unlisted null-valued arguments for board reads. Both `runCompanionTool` in
`src/lib/voiceCompanion/tools.ts` and `CompanionBoardReads.normalize` in
`src/lib/voiceCompanion/boardReads.ts` use it before validation. Declared
arguments still undergo validation, and non-null extras remain refused.

The regressions in `src/lib/voiceCompanion/tools.test.ts` and
`src/lib/voiceCompanion/liveSession.test.ts` include the issue's exact call:

```json
{"project":null,"before":null,"limit":12,"refresh":null,"since":null}
```

They also cover the read callback, default limits, project refusal, non-null
extras and reuse of the live read ledger when the stray null is omitted.

The fresh checks used a detached clone pinned to the assigned baseline, with
`bun install --frozen-lockfile --ignore-scripts`. Every test file had a private
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and the Viewer control URL
pointed at a closed port. The environment came from `checkEnvironment` followed
by `isolatedEnvironment`. All heavy checks ran locally through
`scripts/gate-slot.sh`, with one admitted batch and one file at a time.

Each row used `bun run test <file>`. All 16 selected files completed. The initial
whole-file observations were 604 passes, six failures and 267 gated skips:

| Test file | Initial exit | Pass / fail / skip |
| --- | ---: | ---: |
| `src/lib/voiceCompanion/tools.test.ts` | 1 | 12 / 1 / 0 |
| `src/lib/voiceCompanion/boardReads.test.ts` | 0 | 5 / 0 / 0 |
| `src/lib/voiceCompanion/liveSession.test.ts` | 0 | 129 / 0 / 0 |
| `src/lib/voiceCompanion/codexVoiceSchema.test.ts` | 1 | 3 / 1 / 0 |
| `src/lib/voiceCompanion/companion.test.ts` | 0 | 229 / 0 / 0 |
| `src/lib/voiceCompanion/ownerHistoryRecording.test.ts` | 0 | 52 / 0 / 0 |
| `src/lib/voiceCompanion/delivery.team.test.ts` | 0 | 11 / 0 / 0 |
| `src/lib/voiceCompanion/readPaths.test.ts` | 1 | 16 / 2 / 0 |
| `src/lib/voiceCompanion/provider.test.ts` | 0 | 8 / 0 / 0 |
| `src/lib/voiceCompanion/liveAdapter.test.ts` | 0 | 21 / 0 / 0 |
| `src/lib/voiceCompanion/prototypeFlow.test.ts` | 0 | 2 / 0 / 0 |
| `src/lib/voiceCompanion/prototypeRead.test.ts` | 0 | 9 / 0 / 0 |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | 1 / 0 / 267 |
| `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx` | 0 | 44 / 0 / 0 |
| `src/lib/mcp/schemaParity.test.ts` | 0 | 52 / 0 / 0 |
| `src/lib/mcp/agentFleet.binding.test.ts` | 1 | 10 / 2 / 0 |

The single typecheck, `bun x --no-install tsc --noEmit`, exited 0. Each file
with an initial failure then ran separately through the repository comparator:

```sh
bun scripts/local-gate-tests.ts --base 0728b67c411f29e65b446cf6f4fd591a0c0bb819 <file>
```

All four comparison commands exited 0, with zero new failures. Five assertions
also failed on the captured baseline: the `voice_tools` action policy in
`tools.test.ts`, two project-resolution cases in `readPaths.test.ts`, and the
history-read bound and partial-inventory expectations in
`src/lib/mcp/agentFleet.binding.test.ts`. The initial Codex schema run passed
its assertions but failed child-process teardown; its fresh whole-file run
passed, so the comparator needed no baseline sample for that file. No flaky
classification is claimed for that observation.

Both issue regressions passed. A final fetch still resolved `origin/main` to
the assigned baseline, and the tested clone had no tracked or untracked
changes. This stage changes only this verification note. No broad suite,
rendered browser evidence or performance gain is claimed.

## Original verification, 2026-10-23

Fixes #3226.

Product source: `8d5e73b1e`; main baseline: `faf571855a09e79f3ba33e6278e48a51404426fb`.
The five changed source and test files in the remote checkout matched the
committed files byte for byte by SHA-256. The final main recheck found
`95d52f4db9`, which changes only seat-rotation scheduling and its test.
None of the voice validation modules or test files here changed on main.

On main, `src/lib/voiceCompanion/readSchemas.ts:36` excludes `since` from
`orchestrator_messages`. The unknown-key guards in
`src/lib/voiceCompanion/tools.ts:207` and
`src/lib/voiceCompanion/boardReads.ts:82` reject the reported `since: null`
before reading. The other submitted values, including limit 12 and the
explicit nulls, are valid. The existing design deliberately removed `since`
from message reads (`docs/design/voice-orchestrator-reads.md:211`).

The shared cleanup in `src/lib/voiceCompanion/readSchemas.ts:51` discards
unlisted nulls at both validation boundaries for board reads. Declared
fields still undergo validation. Non-null extras, missing required selectors,
invalid values and foreign-project requests remain refused. Other tool
classes retain their argument validation. The advertised schemas are unchanged.

`src/lib/voiceCompanion/tools.test.ts:65` checks normalization, direct dispatch,
the delegated read callback, default limit 6, explicit limit 12, preservation
of the action tool's valid time filter, and refusal cases. The registry test
also checks null extras for every tool class.
`src/lib/voiceCompanion/liveSession.test.ts:111` reads a stored orchestrator
transcript through the live read ledger and verifies cache reuse with the
extra field omitted. Its clock is fixed.

All heavy checks used `gate-remote --` and `scripts/gate-slot.sh`. Each whole-file
test invocation had its own process, HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR. The comparison gate used the repository's isolated per-file
runner. Tests used fixtures; no live state or paid voice session was used.

The red test command body was:

```sh
bun run test src/lib/voiceCompanion/tools.test.ts src/lib/voiceCompanion/liveSession.test.ts -t "unlisted null"
```

In a remote scratch checkout, restoring the three product modules from main
while keeping the final regression tests produced two failures, exit 1.
The same final tests on the fixed source, with the registry case included
(`-t "unlisted null|all declarations"`), produced three passes, exit 0.

The typecheck command was `bunx tsc --noEmit`. The ESLint command was:

```sh
bunx eslint src/lib/voiceCompanion/boardReads.ts src/lib/voiceCompanion/readSchemas.ts src/lib/voiceCompanion/tools.ts src/lib/voiceCompanion/tools.test.ts src/lib/voiceCompanion/liveSession.test.ts
```

| Check | Exit | Observation |
| --- | ---: | --- |
| Red regressions on main | 1 | Both fail before reading |
| Focused regressions on fixed source | 0 | Three pass |
| Initial typecheck | 0 | No type errors |
| Repeated typecheck | 1 | Runner watchdog notification failed; no type diagnostic; both reported processes subsequently confirmed gone |
| Standalone final typecheck | 0 | Clean supervised retry, no type errors |
| Final ESLint on all five touched TypeScript files | 0 | No errors |
| Full corrected live-session suite | 0 | 128 pass |
| Repository comparison gate | 0 | Zero new, seven pre-existing failures; no flaky results |
| Remote/committed file hash comparison | 0 | Five files match |
| Test collection reconciliation | 0 | All 24 selected files completed |
| Whitespace | 0 | No errors |
| Source and commit publication privacy | 0 | Required known-value fingerprints enabled |
| Verification-note publication privacy | 0 | Required known-value fingerprints enabled |
| Product commit hooks | 0 | Whitespace, privacy and ESLint pass |

Each row below used `bun run test <file>`. Main exits are whole-file runs of
the original main tests; the final tests also ran on main separately for the
red regression evidence above. A dash means the fixed file passed and no
baseline run was needed.

| Test file | Fixed exit | Main exit |
| --- | ---: | ---: |
| `src/app/api/voice-companion/calls/route.test.ts` | 0 | — |
| `src/app/api/voice-companion/session/route.test.ts` | 0 | — |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | 0 | — |
| `src/components/voiceCompanion/voiceCompanionProduct.dom.test.tsx` | 0 | — |
| `src/lib/mcp/agentFleet.binding.test.ts` | 1 | 1 |
| `src/lib/mcp/schemaParity.test.ts` | 1 | 1 |
| `src/lib/orchestrator/relay.test.ts` | 1 | 1 |
| `src/lib/voiceCompanion/boardReads.test.ts` | 0 | — |
| `src/lib/voiceCompanion/callHistory.test.ts` | 0 | — |
| `src/lib/voiceCompanion/callMemory.test.ts` | 0 | — |
| `src/lib/voiceCompanion/callResume.test.ts` | 0 | — |
| `src/lib/voiceCompanion/codexConversation.test.ts` | 0 | — |
| `src/lib/voiceCompanion/codexProvider.test.ts` | 0 | — |
| `src/lib/voiceCompanion/codexVoiceSchema.test.ts` | 0 | — |
| `src/lib/voiceCompanion/companion.test.ts` | 0 | — |
| `src/lib/voiceCompanion/delivery.team.test.ts` | 0 | — |
| `src/lib/voiceCompanion/liveAdapter.test.ts` | 0 | — |
| `src/lib/voiceCompanion/liveSession.test.ts` | 0 | — |
| `src/lib/voiceCompanion/ownerHistoryRecording.test.ts` | 0 | — |
| `src/lib/voiceCompanion/prototypeFlow.test.ts` | 0 | — |
| `src/lib/voiceCompanion/prototypeRead.test.ts` | 0 | — |
| `src/lib/voiceCompanion/provider.test.ts` | 0 | — |
| `src/lib/voiceCompanion/readPaths.test.ts` | 1 | 1 |
| `src/lib/voiceCompanion/tools.test.ts` | 1 | 1 |

The kanban browser file's default run had one pass and 247 gated skips.
No rendered UI evidence is claimed for this backend change.

The seven failures reproduced on main were: the fleet history-read bound and
unselected count (`src/lib/mcp/agentFleet.binding.test.ts`); the pipeline
exhaustion-description expectation (`src/lib/mcp/schemaParity.test.ts`);
the missing-recipient refusal wording (`src/lib/orchestrator/relay.test.ts`);
two project-resolution cases (`src/lib/voiceCompanion/readPaths.test.ts`);
and the missing `voice_tools` action policy
(`src/lib/voiceCompanion/tools.test.ts`). The official gate command was
`bun scripts/local-gate-tests.ts --base faf571855a09e79f3ba33e6278e48a51404426fb`
followed by those five explicit file paths. It confirmed all seven as
pre-existing after fresh head and baseline samples.

The first fixed-tree live-session run exited 1 because the new negative
assertion expected `failed`; the existing result contract returns `refused`.
Correcting that assertion produced the complete 128-test pass above.
The first commit attempt exited 1 because this worktree had no installed
ESLint peers. Locked dependencies were installed in owned scratch and linked
for the unchanged hook, which then passed. No hook was bypassed.

No workflow file changed. No issue comment was posted. No push was performed.
No performance gain is claimed.
