# Test environment isolation

The control revision is `02f9301fc32370210a4af533c1204741c6436f52`, the fetched
`origin/main` at the start of this change. Each file ran in a separate Bun
1.4.0 process, through the committed heavy-command gate, with private HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. The Viewer control URL was
`http://127.0.0.1:1`. The busy run added four Python processes executing
`while True: pass` inside the owned gate; cleanup terminated and awaited only
those four handles. “Idle” means without this additional load.

## Classification

| Reported failure | Base observation under both loads | Cause and change |
| --- | --- | --- |
| Creation: early-switch-off successor wait | Fails: expected two launches, received one | Recovery can file the runtime-host restart request, but the fixture only changes its revision and never acknowledges that request. Await the exact startup tick and acknowledge its second-role request before testing that custody ends. Pin the omitted poll interval too. |
| Ports: managed early admission | Fails after terminal rollback: expected one launch, received zero | The fixture omits the serving Viewer's revision. The production guard correctly retains custody without a matching serving pair. Supply the fake old revision and a deterministic check result. |
| Ports: managed drain-switch-off admission | Same failure | Same incomplete fixture. Both variants now also assert that a terminal receipt with mixed serving revisions keeps the drain held. |
| Four state-owner failures reported before this base | All 30 entry-point cases and all 14 ownership cases pass | Commit `61799bbcc` already clears inherited state aliases and spawn capabilities in the entry-point environment. Preserve every receipt, refusal and byte-snapshot assertion. Remove the remaining native-home/cache dependency. |
| Live CPU pressure | No pressure-related failure reproduced on this base | The test preload already disables pressure sampling. The engine fixture now injects the disabled machine gate explicitly and asserts that it made zero reads of the native CPU pressure file. CPU-policy tests retain their own injected samples. |
| Live runtime host and Viewer | Ambient endpoints could still reach fallback ports | Clear both environment spellings for runtime, registry and capability discovery before loading the engine; pin Viewer control to a closed port. Ownership probes start with a scrubbed environment. |

None of the three reproduced target failures establishes a product defect.
The missing rollback identity exercises the intended conservative refusal.

## State ownership fixture

The former entry-point fixture obtained the native user home in a child and
created its fake installation in that home's cache. The unit fixture used a
fixed directory under node_modules, whose classification depended on the
checkout location. Both now allocate a unique owned sandbox containing a
fake operator home and separate temporary roots.

`setStateOwnershipPathsForTests` supplies the home and temporary-root reads.
Its process-global symbol lets the source preload and compiled MCP bundle see
the same paths. The helper is its only caller. The default ownership policy
continues to use the OS home, OS temporary directory, TMPDIR and the standard
temporary roots. The tests still execute the real entry points, owner claims,
store fences and bundle. Their ownerless process must refuse the fake operator
directory, and refused store writes must leave every seeded byte unchanged.

The probe environment removes inherited Delegatus settings, probe arguments
and Node/Bun options. It retains the owned-runner lifetime context and pins
HOME, USERPROFILE, config, cache and temporary paths. A regression case poisons
both settings prefixes and verifies the intended resolution and unchanged data.

## Base runs

| Explicit test file | Idle pass/fail | Busy pass/fail |
| --- | --- | --- |
| `src/lib/stateOwnership.test.ts` | 14/0 | 14/0 |
| `src/lib/stateOwnership.entryPoints.test.ts` | 30/0 | 30/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 95/2 | 95/2 |
| `src/lib/pipelines/engine.ports.test.ts` | 139/5 | 139/5 |

The machine-readable evidence records execution times, counts and exact
failing test names. A preliminary combined-file run was discarded: the shared
engine fixture's cleanup removed a store still used by another file. All
accepted observations use one explicit file per process.

## Final runs

| Explicit test file | Idle pass/fail | Busy pass/fail |
| --- | --- | --- |
| `src/lib/stateOwnership.test.ts` | 15/0 | 15/0 |
| `src/lib/stateOwnership.entryPoints.test.ts` | 30/0 | 30/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 96/1 | 96/1 |
| `src/lib/pipelines/engine.ports.test.ts` | 141/3 | 141/3 |

All three reproduced target failures pass under both loads. The 50 cases in
the ownership and update-admission groups pass. The four added busy workers
consumed 107.13, 106.33, 106.58 and 106.75 CPU seconds. Each final file run also
received unrelated state and registry sentinels plus inherited overrides in
both settings prefixes; both sentinel files stayed byte-for-byte unchanged.

The evidence JSON records the source hashes, commands, execution times and
exact remaining failure names. Admission waits are excluded from these times.
An interactive gate expired after the completed matrix and lint while its
shell was idle. Final type checking and the project comparison use a fresh
owned gate.

## Repository checks

- `bun node_modules/typescript/bin/tsc --noEmit`: exit 0 (174.52 seconds).
- `bun scripts/eslint-changes.ts --base <control-revision> <seven changed TypeScript files>`: 0 introduced errors and 0 baseline errors.
- `bun scripts/local-gate-tests.ts --base <control-revision> <four explicit test paths>`: exit 0; 0 new failures, 4 pre-existing, 0 removed/skipped and 0 flaky (115.94 seconds).

`privacy-publication-gate.ts --require-known-values --check-commits --base
<control-revision> --paths <changed files>` passed. The PR text was checked with
the same gate's `sensitiveClasses` and `commitMessageAddressReview`, preserving
its required machine-attribution trailer. Scanning that text as an ordinary
file had reported the trailer's role mailbox; the trailer review found no
attributable address.

The comparison sampled only the four remaining failing assertions on the base.
The final source hashes in the evidence match the checked working tree.

## Other existing failures

These failures appeared under both loads on the base and remain outside this
change's two classes:

- Creation: linked checkouts serialize Git writes through their common directory.
- Ports: fixer self-fail with rejected publication.
- Ports: rejecting a later candidate after an earlier confirmed push.
- Ports: settling a later candidate after retrying a rejected push.

The concurrent stage-push change touches the shared engine fixture and separate
port cases. The concurrent MCP transport change touches the entry-point receipt
expectation. Their actual diffs were inspected before editing; those changes
are excluded here.

## Reproduction

Export the selected revision into a private scratch checkout with its pinned
dependencies. Run the following command once for each explicit file in the
table, first with `LOAD=idle`, then with `LOAD=busy`. Create RUN_ROOT under the
stage-owned TMPDIR and set TEST_FILE to the selected repo-relative path.

```sh
mkdir -p "$RUN_ROOT/home" "$RUN_ROOT/config" "$RUN_ROOT/state" "$RUN_ROOT/tmp"
HOME="$RUN_ROOT/home" XDG_CONFIG_HOME="$RUN_ROOT/config" \
LLV_STATE_DIR="$RUN_ROOT/state" TMPDIR="$RUN_ROOT/tmp" \
LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 \
bash scripts/gate-slot.sh python3 - "$TEST_FILE" "$LOAD" <<'PY'
import subprocess, sys
workers = []
try:
    if sys.argv[2] == "busy":
        workers = [subprocess.Popen([sys.executable, "-c", "while True: pass"])
                   for _ in range(4)]
    result = subprocess.run(["bun", "test", sys.argv[1]])
finally:
    for worker in workers:
        worker.terminate()
    for worker in workers:
        worker.wait()
raise SystemExit(result.returncode)
PY
```
