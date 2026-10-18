# Fresh install startup

On 2026-10-18, the published `delegatus-cli@1.13.0` failed its identity
migration on both the first and second start of a clean Linux installation.
The public terminal transcripts are in
[`evidence/fresh-install-startup/`](../../evidence/fresh-install-startup/).
The manifest records runtime versions, source digests, transcript digests and
counts. The reproduction captured exact streams in private stage scratch. To pass
the publication gate, committed copies replace ephemeral service and request
UUIDs with stable RUN_ID placeholders; all other bytes remain unchanged.
The manifest records both raw and public digests. These runs make no speed or
memory claim.

## Reproduction

Each runtime used a separate fresh directory under the stage's scratch root.
HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR and LLV_STATE_DIR were private.
The child inherited only PATH, the user service-manager connection, locale and
terminal settings. Its PATH contained a private Bun link and system tools;
Claude Code and Codex were absent. LLV_VIEWER_CONTROL_URL pointed to
`http://127.0.0.1:1`, a closed port. DELEGATUS_TELEMETRY was 0, LLV_LANG was en,
and the browser opener was disabled. No state-owner token was supplied.

The reproduction launched `bun x delegatus-cli@1.13.0 --port <ephemeral-port>
--no-open`, with stdout and stderr sharing one file. A port-0 socket selected
the port before launch. It polled GET / until HTTP 200, then kept collecting
until the third identity-wave failure or 22 seconds after readiness. It sent
SIGINT to its recorded child, awaited exit, and repeated with the same private
state. The owning gate supervised all descendants.

Both starts printed three identity-wave failures. Bun 1.4.3 produced the
reported `SQLiteError: NOT NULL constraint failed: registry_rows.value_json`.
Bun 1.4.0 produced `identity migration state changed while reading evidence;
retry at startup`. This independent reproduction distinguishes the two
messages; the originating report described the SQLite error under both.

The service-manager OOM-policy advice in the transcripts belongs to the
throwaway gate service. It is actionable service configuration advice and
remains visible. Package resolution lines belong to Bun's first download.

## Cause and correction

`src/lib/viewerInstrumentation.ts:583` retries a failed migration three times
and prints its error. The migration is prepared in
`AgentRegistry.runIdentityWaveMigration` in `src/lib/agent/registry.ts`.
It compared a lazy SQLite mutation view directly with an ordinary JSON
snapshot using `isDeepStrictEqual`.

Bun's constructor inspection reaches the mutation proxy. Under 1.4.0 the
unchanged empty collections compare unequal. Under 1.4.3 it leaves a synthetic
`entries.constructor` change. After replacement with plain prepared rows,
the SQLite persistence path's inherited-property lookup finds the Object
constructor. A diagnostic probe at `SqliteAgentRegistryStore.upsertRow`
confirmed collection `entries`, key `constructor`, type `function`.
`JSON.stringify` returns undefined for that function, and the SQLite insert
violates its value_json NOT NULL constraint. The transaction rolls back,
including the migration's completion marker, so every subsequent start retries.

The guard now materializes the mutation view through the registry's existing
JSON clone before comparing data. A clean registry completes once with zero
migrated rows. The durable completion marker makes later starts return before
cloning retained history or taking a write lease. Existing installations still
retitle, rekey and stamp lineage, with the same evidence checks, rollback,
dry-run and completion semantics.

The shared write path was traced through the startup wrapper, registry
snapshot and clone, mutation tracking, full prepared-file replacement, SQLite
row persistence and migration metadata. JSON, dual-write, SQLite-read and
SQLite-authoritative modes keep their existing defaults and schema. Only the
comparison inside this migration changes; generic SQLite persistence is
unchanged.

## Terminal lines removed or demoted

The launcher already sets LLV_QUIET_DIAGNOSTICS unless DELEGATUS_DEBUG=1.
These changes complete that choice at the diagnostic producers:

| Line | New behaviour |
| --- | --- |
| Launcher copy of “Delegatus sends a random id…” (en and uk) | Removed. The Viewer's existing first-run notice and durable marker remain responsible for disclosure. |
| “Reads logs from ~/.claude/projects, ~/.codex/sessions, ~/.copilot/session-state.” (en and uk) | Printed with DELEGATUS_DEBUG=1. |
| `[runtime host] journal <subphase>: <done>/<total>, committed batches <count>` | Debug output under the CLI; the startup evidence file still records progress. Fresh runs previously printed schema, receipt-backfill, integrity-check and hash-chain lines. Checkpoint-reconciliation follows the same rule on existing state. |
| `[viewer loop-gap] <JSON>` | Debug output under the CLI, for both Viewer and runtime-host diagnostics. |
| `[performance summary] <JSON>` | Debug output under the CLI, including later minute summaries. |
| `[files response worker] retired: viewer exit`, with pid and rssBytes | Debug output for normal shutdown. Unexpected retirement warnings remain visible. |
| `[flow pipeline controller] scan-dependent flow phase skipped: still scanning, retry in 5 s` | Debug output; the next controller cycle still retries. |

Direct service launches continue to send diagnostics to their journal.
DELEGATUS_DEBUG=1 restores them in a CLI terminal. URL/readiness, installation
instructions, phone-access guidance and real errors remain visible.

The install-ping sender and src/lib/activity were left to their owning lanes.

## Verification

All checks ran in a scratch source export, with private HOME, XDG_CONFIG_HOME,
TMPDIR and LLV_STATE_DIR and the Viewer control URL on the closed port above.
Heavy checks ran one at a time through the prescribed gate-slot wrapper.

The new fresh-process cases were run against the original registry source at
a25592be with the same isolation: SQLite and read modes fail on both Bun
versions; off and dual-write modes pass. The fixed source passes all four
modes through two real processes. Additional SQLite cases reject a concurrent
writer or failed evidence read, preserve state and then migrate successfully.

Focused test paths:

- `src/lib/agent/identityWaveMigration.completed.test.ts`
- `src/lib/agent/identityWaveMigration.test.ts`
- `bin/cli.exposure.integration.test.ts`
- `src/lib/viewerLoopMonitor.test.ts`
- `src/runtime-host/runtimeHostStartup.test.ts`
- `src/lib/scanner/filesResponseWorker.test.ts`
- `src/lib/pipelines/controller.test.ts`
- `src/lib/performanceSpans.test.ts`

The migration files ran under Bun 1.4.0 and 1.4.3. Launcher cases cover en and
uk, first start and restart, debug output and an error reaching the terminal.
Runtime-host progress tests retain evidence while quiet and reject corrupt
evidence. Loop-sink tests retain bounded backpressure and debug output.

The final source was built with `bun run build`; the runtime host was bundled
with `bun build src/runtime-host/main.ts --target=bun --format=esm
--outfile=dist/runtime-host.mjs`. The final startup captures use that compiled
Viewer and host through `bun bin/cli.mjs`, with the same two-start procedure.
Required hosted contexts remain typecheck, privacy-publication,
privacy-tracker-audit and runtime-gate.

Local typecheck (bun node_modules/typescript/bin/tsc --noEmit) passed.
The runtime-host rehearsal under Bun 1.4.0 completed succession and answered
27/27 listener polls and 27/27 socket polls over 15 seconds, with 13 abandoned
callers on each endpoint. Viewer verification loaded 29/29 compiled server
modules and GET / answered HTTP 200.

The eight focused test files passed 110 cases in total. The 34 migration cases
also passed under Bun 1.4.3. The new fresh-state cases fail against a25592be
and pass with the correction under both interpreters.
