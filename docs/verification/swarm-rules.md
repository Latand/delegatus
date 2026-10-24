# Swarm rules: slice 1 verification

Verified on 2026-10-23 against the slice 1 specification in
`docs/design/swarm-role-memory.md#31-slice-1-swarm-rules-shipped-with-releases-receive`,
starting from `bf1c0024`. The initial release pack is empty. No local learned
rule text was added to public files. Counts, proposals and running the
maintainers' pack pipeline remain deferred.

## Slice items and evidence

| Item | Implementation and evidence |
| --- | --- |
| 1. Reviewed release pack | `src/lib/memory/swarmRules.json`; `swarmPack.ts` validates schema, content-addressed ids, unique ids, eligible roles, dates, 300 code points per instruction, 4 000 rendered code points per role and 36 000 overall. `src/lib/memory/swarm.test.ts` exercises valid and refused inputs, including Unicode and rendered-line overhead. |
| 2. Fifth scope and delivery | `roleScopes.ts`, `roleTypes.ts`, `roleStore.ts`, `roleRender.ts`: `swarm:<role>` follows the role-on-every-project scope, has its own public notice and count, and goes through the existing snapshot, byte ceiling and delivery ledger. Tests pin the exact off-state block, order, cap, ledger hash, delivered and undelivered usage ids, clean roles and memory off-switches. |
| 3. Frozen re-render and withdrawal | `roleSelection.ts` resolves entries from the serving pack or their frozen line, verifying the content id and SHA-256 hash. Tests restart a real process with an empty serving pack, withdraw a local rule, reject an unprovable frozen line, and switch receiving off during asynchronous selection and on resume. |
| 4. Narrow privacy exemption | `roleStore.ts` builds a normalized matcher from the shipped pack for each privacy read. Only matching stored rule text is exempt; every explanation remains private. Tests run the real publication gate: public pack text passes; explanations and private case/punctuation variants fail. A local lookalike still gets withheld. |
| 5. Curator | `curation/brief.ts`, `curation/read.ts`, `roleViewSource.ts` supply read-only pack evidence, receiving status, and applied/misled counts from lesson requests, including answers that left no lesson. A real curation test archives redundant local guidance as `in-instructions`, with `swarm:<id>` evidence checked against the serving pack for the same role, including on a separate repository. The final-message instructions add pack candidate ids and counts. |
| 6. One switch and read-only window | `src/lib/telemetry/store.ts`, `src/app/api/telemetry/route.ts`, `TelemetrySettings.tsx`: persisted receiving defaults off, independently of install ping. Both locales disclose receiving now and anonymous text-free counts later. `LearnedRules.tsx`, `MemoryProfile.tsx` and `profile.ts` preserve the swarm role identity, count and read-only presentation. Origin and invalid-body tests prove refused writes leave consent unchanged. DOM tests cover failed saves. |
| 7. Maintainers' pass | `docs/guide/swarm-pack-pass.md` specifies a weekly pipeline that drafts a pack pull request, requires operator approval and ships the approved pack in a release. This stage did not run it. |

Abbreviated memory paths in the table are under `src/lib/memory`. UI component
paths are under `src/components/telemetry` or `src/components/roleMemory`.

## Contracts traced

The preference producers are the legacy preferences file and independent
per-field writes. Their readers are the telemetry route, the settings dialog,
the ping sender and `swarmRulesEnabled`. Missing receiving consent defaults
off. The sender continues to read its existing ping consent; this slice adds
no sender or network endpoint.

The scope path runs from the pack through scope helpers, canonicalization,
the launch snapshot, frozen selection, delivery ledger, usage validation,
curation, project view, rules window and profile summaries. Swarm keys have no
project identity. `LessonInput` excludes swarm; both parsing and the store
reject writes to that scope. Curation reads pack evidence without granting a
writable pack scope. No SQLite schema or local rule row format changed.

## Rendered evidence

`evidence/swarm-rules/rendered.json` records six source SHA-256 digests and
eight combinations: en/uk, light/dark, 1440/390 pixels. The existing kanban
driver's `swarm release rules` case captures off, refused-save and rules-window
frames for each combination. All 24 frames were opened and visually inspected.
The new explanation and inline error remain visible; the swarm row has no
delete or revert control. The record includes text-range visibility, overflow,
scope order, focus and scroll observations. Phone subtitles retain their
existing ellipsis.

Reproduce with isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR:

```sh
gate-remote -- env LLV_KANBAN_BROWSER_TEST=1 bun test --timeout=60000 \
  ./src/components/kanban/kanbanBoard.browser.test.tsx \
  -t 'swarm release rules|subscription API consent'
```

Result: exit **0**, 2 passed, 0 failed. The neighboring subscription-consent
case also covers both languages, themes and viewports.

## Tests by explicit path

Every row used `gate-remote -- bun test --timeout=60000 <path>`, one file per
fresh test process. The wrapper supplied private state and configuration
roots and a closed Viewer control port. No test used operator state.

| Path | Passed | Exit |
| --- | ---: | ---: |
| `src/lib/memory/swarm.test.ts` | 21 | 0 |
| `src/lib/memory/roleStore.test.ts` | 14 | 0 |
| `src/lib/memory/roleSelection.test.ts` | 10 | 0 |
| `src/lib/memory/roleView.test.ts` | 16 | 0 |
| `src/lib/memory/roleCuration.test.ts` | 8 | 0 |
| `src/lib/memory/roleEgress.test.ts` | 9 | 0 |
| `src/lib/memory/curation/reviewLessons.test.ts` | 5 | 0 |
| `src/lib/memory/curation/curation.test.ts` | 92 | 0 |
| `src/lib/memory/profile.test.ts` | 6 | 0 |
| `src/lib/telemetry/sender.test.ts` | 32 | 0 |
| `src/app/api/telemetry/route.test.ts` | 13 | 0 |
| `src/components/roleMemory/LearnedRules.render.test.tsx` | 12 | 0 |
| `src/components/roleMemory/MemoryProfile.dom.test.tsx` | 4 | 0 |
| `src/components/telemetry/TelemetrySettings.dom.test.tsx` | 3 | 0 |

The telemetry suite used an isolated copy of the local Docker CLI and Compose
plugin, with a private Docker configuration directory, for `compose config`.
No daemon or machine configuration changed.

## Other checks

| Command | Exit | Result |
| --- | ---: | --- |
| `gate-remote -- bunx tsc --noEmit` | 0 | No type errors |
| `gate-remote -- bunx eslint <all touched TS/TSX paths>` | 0 | No errors; three unused-variable warnings (`deskCard`, `_reason`, `file`) |
| `git diff --check` | 0 | No whitespace errors |

The final type/lint invocation also reran the 21 swarm cases after the last
pack validation edit: exit **0**. The stage report records the publication
privacy check and the plain commit's hook result. `.github/workflows` has no
change. The tracked base remained `bf1c0024` during verification.

## Earlier attempts and baseline observations

- Initial typecheck: exit **2**. Corrected the writable lesson-scope type and
  two test types/expectations for the new preference. The final typecheck exits
  **0**.
- Initial swarm suite: exit **1**, 17 passed and 2 failed. The assertions now
  preserve the existing privacy filter's trailing full stop. Later runs pass,
  including the additional race and withdrawal cases.
- An initial explicit-path batch: exit **1** at the nonexistent
  `roleStage.test.ts` filter. The corrected path list above runs the existing
  parser coverage in `roleCuration.test.ts`.
- Additional unchanged `src/lib/memory/roleEgressUnreadable.test.ts`: exit
  **1** on both the branch and an isolated archive of `bf1c0024`, with the
  same 1 pass/1 fail and `bridge report log is busy` at the empty-store bridge
  assertion. This pre-existing failure remains outside this slice.
- The rules-window suite initially exited **1** on both base and branch
  (10 passed, 1 failed). Its role-tabs test predates the Profile opening page
  introduced by `fee3697cb`; the test now opens All rules through the real
  navigation, then checks both role names and rows. Final suite: exit **0**.
- Telemetry initially exited **1** (28 passed, 4 failed) because the remote
  runner lacked Docker. Supplying the isolated tools produced 32 passes,
  exit **0**.
- One later remote test batch lost its SSH connection, exit **255**. Its full
  affected file was rerun alone in the next sequential batch, exit **0**.
- The full browser driver was invoked on the base before adding the case.
  Its dashboard timing case failed at 78.5 ms against 50 ms; the owned run
  was then stopped, exit **143**. That run has no full-driver verdict. The
  affected settings cases have the focused passing verdict above; this stage
  makes no performance claim.

## Curator review fixes

The archive write accepts `swarm:<id>` only for `in-instructions`, while
receiving is enabled and the serving pack holds that id for the archived
rule's role. Project and machine scopes cannot cite a role's pack entry.
The existing repository-file evidence checker still handles file citations;
import drops retain that checker. The MCP schema already passes `where` as
an optional string, and archive history, operator views and restore retain
or clear it through their existing copies. No schema migration is needed.

The curator brief includes the pack evidence instruction and pack-pass
candidate request only while receiving is enabled. Its off-state SHA-256 is
pinned to the brief from `bf1c0024` with the default seat budget. Scope reads
also omit swarm metadata while receiving is disabled.

Focused regressions in `src/lib/memory/swarm.test.ts` use a freshly initialized
repository separate from Delegatus for successful curation. Refusal cases
cover absent ids, another role's id, other archive reasons, consent revoked
after reading, pack withdrawal after reading, and project/machine scopes;
each refusal preserves the view. The prompt check toggles consent off/on/off.

Fix-round verification uses the owned gate wrapper and `gate-remote` with
isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. On the revised
source, `bunx tsc --noEmit` and ESLint on the four touched TypeScript files
both exit 0 with no diagnostics. `bun run test` over these explicit paths
exits 0 with 155 passes and no failures:

- `src/lib/memory/swarm.test.ts`
- `src/lib/memory/curation/curation.test.ts`
- `src/lib/memory/curation/import.test.ts`
- `src/lib/memory/curation/seatRules.test.ts`
- `src/lib/memory/curation/reviewLessons.test.ts`

The two finding reproductions run with the revised tests and the three
curation source files restored to `e80171f0d` in the remote scratch export:
`bun run test src/lib/memory/swarm.test.ts -t "curator sees usage|curator swarm instructions"`
exits 1 with exactly 2 failures: missing file evidence and the off-state brief
hash. Restoring the revised source and running
`bun run test src/lib/memory/swarm.test.ts -t curator` exits 0 with 11 passes.

The following additional explicit-path batch was compared on `e80171f0d`
and the revised source under the same isolation:

| Test file | Reviewed source passes | Revised source passes |
| --- | ---: | ---: |
| `src/lib/mcp/curateRules.test.ts` | 3 | 3 |
| `src/app/api/role-memory/curation.test.ts` | 1 | 1 |
| `src/lib/memory/roleView.test.ts` | 16 | 16 |
| `src/lib/memory/roleReviewLessons.test.ts` | 10 | 10 |
| `src/lib/memory/roleProblems.test.ts` | 8 | 8 |
| `src/lib/memory/importLifecycle.test.ts` | 17 | 17 |
| `src/lib/memory/importSync.test.ts` | 16 | 16 |
| `src/lib/memory/source.import.test.ts` | 13 | 13 |

Both runs exit 1 with 84 passed tests and one unnamed teardown failure at
`src/lib/testing/testChildren.ts:102`: two test-created workers survive until
the harness cleans them up. The original revised-source run has the same
outcome. There is no new assertion failure; the cleanup failure also occurs
on the reviewed source. This fix makes no change to the worker lifecycle.
