Voice read argument recovery verification, 2026-10-23. Fixes #3226.

Product source: `8d5e73b1e`; main baseline: `faf571855a09e79f3ba33e6278e48a51404426fb`.
The five changed source and test files in the remote checkout matched the
committed files byte for byte by SHA-256. Main was fetched again and still
pointed to that baseline.

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
