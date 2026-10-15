# Historical DOM test inventory

Inventory date: 2026-10-15. Baseline: current `origin/main` at
`77fc690eac3880cce9507d365d47e5bc0e152354`, fetched before the inventory.
Bun: 1.4.0, with the frozen lockfile installed. The earlier findings in
[main-test-recovery.md](main-test-recovery.md) and PRs #2489 and #2508 were
checked against this baseline; their old counts are historical.

Each row is one explicit test path in its own Bun invocation through the
pipeline-owned `gate-slot.sh` wrapper. Each invocation gets a fresh OS-temp
`HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, and `LLV_STATE_DIR`. Ambient `LLV_*` and
`DELEGATUS_*` variables are removed before setting the isolated state root,
the owned-run deadline, and `LLV_VIEWER_CONTROL_URL`. The control URL uses a
loopback port reserved by a bound, non-listening socket for the whole run.
Only the temporary root created for that invocation is removed afterward.
No directory suite or live-state test was run.

To repeat one row with the repository's owned runner, pass its explicit path
to this isolation wrapper. The pipeline used its controller-supplied copy of
`gate-slot.sh` with the same command and environment:

```sh
python3 - ./src/components/EffortPills.slot.dom.test.tsx <<'PY'
import os, pathlib, socket, subprocess, sys, tempfile
with tempfile.TemporaryDirectory(prefix="dom-inventory-", dir="/tmp") as root:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("LLV_", "DELEGATUS_"))}
    for key, part in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"),
                      ("TMPDIR", "tmp"), ("LLV_STATE_DIR", "state")]:
        directory = pathlib.Path(root, part)
        directory.mkdir()
        env[key] = str(directory)
    with socket.socket() as closed:
        closed.bind(("127.0.0.1", 0))
        env["LLV_VIEWER_CONTROL_URL"] = f"http://127.0.0.1:{closed.getsockname()[1]}"
        env["LLV_OWNED_RUN_TIMEOUT_MS"] = "300000"
        result = subprocess.run(["bash", "scripts/gate-slot.sh", "bun", "test",
                                 *sys.argv[1:]], env=env)
    sys.exit(result.returncode)
PY
```

## Per-file results

Counts are pass / fail / skip. A zero skip count is omitted. Before and after
each run the same complete file. The existing opt-in browser case remains
skipped in the delivery suite. Fenced failures remain failing assertions.

Before: **254 pass, 106 fail, 1 skip; 9 green files**. After: **289 pass,
71 fail, 1 skip; 15 green files**. This repairs 35 failing cases. The 71
remaining failures are the explicitly deferred cases below.

<!-- inventory-table -->

| Explicit test path | Main before | Branch after | Disposition |
| --- | ---: | ---: | --- |
| `src/components/EffortPills.slot.dom.test.tsx` | 3 / 4 | 7 / 0 | Fixture repaired |
| `src/components/LogFeed.deliveryUncertainty.dom.test.tsx` | 26 / 61 / 1 | 26 / 61 / 1 | Deferred: composer send/receipt fence |
| `src/components/LogFeed.startingWindow.dom.test.tsx` | 40 / 2 | 42 / 0 | Intended activity-dot contract; fixture repaired |
| `src/components/TmuxComposer.runtimeSnapshot.dom.test.tsx` | 9 / 8 | 9 / 8 | Deferred: composer/autonomy fence |
| `src/components/Viewer.switching.dom.test.tsx` | 3 / 8 | 9 / 2 | Fixture repaired; two dashboard cases deferred |
| `src/components/kanban/KanbanAccounts.dom.test.tsx` | 17 / 0 | 17 / 0 | Already green; unchanged |
| `src/components/mobile/directReviewDeck.dom.test.tsx` | 5 / 0 | 5 / 0 | Already green; unchanged |
| `src/components/mobile/mobileSeatCard.dom.test.tsx` | 27 / 0 | 27 / 0 | Solo green; shared-process mock repair |
| `src/components/orchestrator/OrchestratorPanel.dom.test.tsx` | 75 / 2 | 77 / 0 | Intended unconfirmed usage; mock repair |
| `src/components/orchestrator/dockOpenState.dom.test.tsx` | 0 / 2 | 2 / 0 | Intended board-seat ownership; mock repair |
| `src/components/scheme/SchemeBoard.lineage.dom.test.tsx` | 4 / 0 | 4 / 0 | Already green; unchanged |
| `src/components/scheme/SchemeBoard.pipelineComposition.dom.test.tsx` | 2 / 0 | 2 / 0 | Already green; unchanged |
| `src/components/scheme/SchemeBoard.pipelineRegions.dom.test.tsx` | 5 / 0 | 5 / 0 | Already green; unchanged |
| `src/components/scheme/directReviewBoardComposition.test.ts` | 3 / 0 | 3 / 0 | Already green; unchanged |
| `src/components/scheme/layout.lineage.test.ts` | 10 / 0 | 10 / 0 | Already green; unchanged |
| `src/components/scheme/nodes.dom.test.tsx` | 1 / 5 | 6 / 0 | Active-pane and user-scroll fixtures repaired |
| `src/components/workflows/legacyDraftPurge.dom.test.tsx` | 4 / 14 | 18 / 0 | Intended hidden-directory and source-refusal contracts |
| `src/hooks/useFiles.dom.test.tsx` | 20 / 0 | 20 / 0 | Solo green; preserve/restore all bus exports |

<!-- /inventory-table -->

## Cause and disposition

All changes are test fixtures or expectations. Product behavior is unchanged.
The stale expectations below were checked against the landed behavior and its
design or commit before changing the tests.

| File / cases | Cause | Repair and retained contract |
| --- | --- | --- |
| `EffortPills.slot`: desktop, phone, fallback badge, narrow scheme pane | The DOM fixture lacks animation frames; the scheme fixture requests a dormant pane whose native content is intentionally unmounted. | Supply the window's animation-frame methods and mount an active pane. Keep all slot, tooltip, wrapping, and counter-zoom assertions. |
| `scheme/nodes`: anchor remount, migration successor, viewport offset, prepended history, bottom following | The native pane needs an active fixture and animation frames. An untagged programmatic scroll does not express the user's intention to leave the tail. | Mount active content and dispatch an upward wheel gesture before the scroll. Keep exact anchor distances, identities, and remount behavior. |
| `LogFeed.startingWindow`: both elapsed-time cases | #2783 replaced the header's elapsed badge with an accessible activity dot. | Assert the header's working label and keep every footer elapsed-time assertion, including the negative check against restarting at transcript time. |
| `Viewer.switching`: project links, cold deep link, phone revisits/swipes, project sheet | The rail markup changed; the shared visibility observer requires a target and asynchronous notification after registration. | Select the rail by project identity; deliver target-bearing observer records asynchronously. Keep synchronous cached paint, remount, and latency assertions. |
| `Viewer.switching`: cached project switch | #2372 added a project-presence HEAD heartbeat. The fixture counted it as a catalog request and returned a catalog body. | Model bodyless HEAD responses separately. Require one catalog GET and the three expected project heartbeats. |
| `Viewer.switching`: unrelated reader renders on in-app focus and a fresh tail | The real board renders unrelated feeds (6 and 3 respectively, expected 0). | Preserve both zero-render assertions. Deferred to the dashboard derivation owner. |
| `orchestrator/OrchestratorPanel`: estimated usage and estimated 100% | #2667 makes estimated usage unconfirmed until a provider reading arrives. | Assert the unconfirmed label, preserved estimate basis in the tooltip, muted estimate, and danger tone for a provider-reported 100%. |
| `orchestrator/dockOpenState`: both legacy preference cases | The desktop always opens its kanban board; its seat owns the orchestrator. A second legacy dock is no longer the intended surface. | Assert one seat per project across switches, no duplicate dock, and preservation of both the global seed and project preferences. |
| `workflows/legacyDraftPurge`: project, restored/fresh handoff, source lookup/retry, provisional root, hydrated root, retried launch | #2559 hides the inherited directory; the removed picker cannot expose its value. Cards also start folded under the calm-card design. | Inspect retained draft state, exercise card expansion through its control, and assert the restored project directory and prompt in the launch request. Keep source precedence, retry bounds, and draft retention. |
| `workflows/legacyDraftPurge`: 390px target | #2559 removed the directory picker. | Assert the inherited directory, absence of that control, and the current launch button's 44px target. |
| `workflows/legacyDraftPurge`: deleted or missing source | The new-agent design holds a handoff until its source directory is known and available. The old tests expected a launch from an unavailable source. | Require a disabled launch control, the visible reason, zero POSTs, and retained prompt/directory. |
| `workflows/legacyDraftPurge`: closing a conversation card | The default-folded card hides the reader action. | Expand the card before opening the reader and retain the exact close-path callback assertion. |

The directory decisions are specified in
[new-agent-redesign.md](../design/new-agent-redesign.md), including source-only
handoff directories and holding an unresolved project. Default card folding is
specified in [calm-task-cards-build.md](../design/calm-task-cards-build.md).
The estimate behavior is in `IncumbentHeader.tsx` at commit `39f3f44a0c`;
the activity-dot change is commit `a779cb1be`; presence heartbeats are commit
`4e755cacfa`. These are intended product changes, so their tests were updated.

## Shared-process isolation

The original dock, mobile seat, and orchestrator panel group had 99 passes and
7 failures. Its isolated files totaled 102 passes and 4 failures. The three
additional failures were the delivered mandate card, a user row without
provenance, and the cached transcript when returning to a project.

The dock imported LogFeed before the later module mocks. LogFeed's production
dependency object had already captured the original tail hook, so replacing
the module afterward did not supply the fixture's transcript. The suites now
use the existing `setLogFeedDependenciesForTests` lifecycle seam and reset it
after unmount. The same repair applies to the touched EffortPills, nodes, and
starting-window fixtures.

The dock and Viewer use `setRuntimeUiEnabledForTests` and reset it in cleanup.
The useFiles runtime-bus mock preserves every export and restores a snapshot
of the real exports after the file. Runtime-hook restoration also snapshots
exports before mocking: Bun module namespaces are live, so retaining the
namespace itself can retain the replacement. The Viewer restores its card
folding override. The dock uses the existing scoped React act helper.

<!-- combined-results -->

After: **199 pass / 0 fail across eight files in one Bun process**, 122.74s
of runner execution. The original three-file group contributes 106 passes
and zero failures to that run. Every file also passes alone.

The exact argument order was:

```text
src/hooks/useFiles.dom.test.tsx
src/components/orchestrator/dockOpenState.dom.test.tsx
src/components/mobile/mobileSeatCard.dom.test.tsx
src/components/orchestrator/OrchestratorPanel.dom.test.tsx
src/components/EffortPills.slot.dom.test.tsx
src/components/scheme/nodes.dom.test.tsx
src/components/LogFeed.startingWindow.dom.test.tsx
src/components/workflows/legacyDraftPurge.dom.test.tsx
```

Putting useFiles first exercises restoration of its bus before the real
Viewer and later module mocks load. The same isolated roots, closed control
port, and owned runner were used for this combined check.

<!-- /combined-results -->

## Fenced cases

`TmuxComposer.runtimeSnapshot.dom.test.tsx` and
`LogFeed.deliveryUncertainty.dom.test.tsx` are unchanged. Their failures reach
the composer send, receipt, and recovery paths reserved for the autonomy and
send-latency lanes. The actual owner diffs were inspected before the deferral.

- Runtime snapshot: recovery details fail at browser persistence; late and
  queued receipts fail settlement expectations; the five invalid/missing-time
  variants assume text echoes retire a pending row. Eight cases remain red.
- Delivery uncertainty: 61 cases remain red across textless recovery,
  operation identity, terminal receipts, late callbacks, producer settlement,
  capacity, payload retention, and selected-context retry. Observed mismatches
  include automatic original-key lookups, persistence setup, and receipt/echo
  expectations. The old global prohibition on “Not delivered” also conflicts
  with the operator's October 11 at-rest counter in `TmuxComposer.tsx`.
  These observations do not establish that every failing assertion is stale.
- Dashboard derivation: the two Viewer zero-render cases remain red. The owner
  accepted those cases while leaving this lane's fixture changes separate.

The composer findings were delivered to the send-latency owner, who recorded
them as follow-up notes outside that lane's prerequisite-overlap regression;
the autonomy owner was also notified. No operator decision was invented to
make these cases pass. Codex feed parsing, dashboard product derivation,
autonomy settings, and composer product files were left untouched.

## Publication checks

<!-- publication-results -->

The complete per-file inventory and the combined check above are local
verification. `git diff --check` passes. The diff was reviewed against the
listed causes, retained assertions, mock teardown, and the owner fences.
No product file, test skip, or timeout relaxation was added.

The normal publication hooks run staged privacy and changed-file ESLint, then
TypeScript, changed-file ESLint, privacy including commit identities, and
isolated touched-test comparison against the merge base. The PR records those
outcomes and the required CI contexts: `privacy-publication`,
`privacy-tracker-audit`, `runtime-gate`, and `typecheck`.

<!-- /publication-results -->
