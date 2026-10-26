# Cloud result 10: independent voice-tool verification

Origin: Codex Cloud (GPT-6.1 Sol), export `10.diff` and its supplied `10.md` report. Verified on 2026-10-23 against main `adce5764927f7e838f20070cd2968128912e861c`.

SHA-256 matches `10.meta.json`: `72b3c4d9ba4ce06368c1487a8039817cdfc5a3f065deba3f556621fcc0b0454c` (6,119 bytes).

Kept: all seven cases in `src/lib/voiceTools/contracts.test.ts` and `src/lib/voiceTools/hub.test.ts`: exact schema byte/depth boundaries, aggregate paginated limits, cross-page normalized collisions, and late-page credential echoes in descriptions, annotations and schema defaults. Pagination failures require an empty durable catalog and refused approval; the credential cases reopen the store and check the serialized record.

Dropped: none. These cases exercise the existing slice-1 contract, dry-run worker and store. They require no code from the unmerged slice 2 in #3251 and establish no claim about that slice's call-time security. The overlapping #3258 hub-test diff changes different hunks.

The patch applies unchanged. No production module or workflow changes.

## Commands and exits

`CLOUD_RESULTS` denotes the supplied private export directory. Heavy checks used the pinned installed gate-slot wrapper and `gate-remote`. Each test file ran in its own process with fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR; the Viewer control endpoint was closed. The remote transport batched the serial commands through its isolation helper. The branch batch ended with `RAN_COUNT 6 FAILED 0` and `TYPECHECK_EXIT 0`.

| Command | Exit |
|---|---:|
| `sha256sum "$CLOUD_RESULTS/10.diff"`, compared with `10.meta.json` and byte count | 0 |
| `git apply --check "$CLOUD_RESULTS/10.diff"` | 0 |
| `git apply "$CLOUD_RESULTS/10.diff"` | 0 |
| `gate-remote -- bash -c '<serial isolated test loop, then typecheck>'` | 0 |
| `bun x tsc --noEmit --incremental false` inside that remote call | 0 |
| `bun x eslint src/lib/voiceTools/contracts.test.ts src/lib/voiceTools/hub.test.ts` | 0 |
| `git diff --check` | 0 |
| `bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main` | 0 |

ESLint retains the existing `no-unused-expressions` warning in `src/lib/voiceTools/hub.test.ts:374`; the expression is unchanged from main.

The following commands ran on both main and the patch-10 tree. The inventory resolves relative and aliased static/dynamic imports, type imports, mocks, and embedded subprocess imports of the tested catalog/hub modules.

| Command | Main exit | Branch exit |
|---|---:|---:|
| `bun test --timeout=60000 src/app/api/voice-tools/route.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/components/voiceCompanion/VoiceToolsSetting.dom.test.tsx` | 0 | 0 |
| `bun test --timeout=60000 src/lib/mcp/voiceTools.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/voiceTools/contracts.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/voiceTools/hub.test.ts` | 0 | 0 |
| `bun test --timeout=60000 src/lib/voiceTools/store.test.ts` | 0 | 0 |

The branch ran 93 passing cases; 14 existing cases were skipped by their stdio/platform prerequisites. All seven added cases executed successfully. The main-side results were collected with the full two-patch importer inventory; its unrelated failures and interrupted first batch are documented in [cloud-results-11.md](cloud-results-11.md).

Self-review: only the supplied assertions were added; test clocks and fixture names remain fixed, HTTP peers bind port 0, and cleanup uses only each test's own roots and listeners. No performance gain is claimed.
