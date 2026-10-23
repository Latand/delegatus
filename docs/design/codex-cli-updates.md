# Automatic Codex CLI updates

The existing minute update scheduler checks the Codex updater independently of
Delegatus application updates. The updater persists its registry deadline before
network access and checks npm's latest stable `@openai/codex` at most once per
24 hours. A pending, proven candidate retries idle admission each minute without
another registry request, install or probe.
The stored proof includes the serving release, pinned schema and bundled fixture
digest. A changed contract triggers a fresh probe before a waiting candidate can
switch, including after process replacement.

## Preparation and compatibility

`src/lib/codexUpdate/update.ts` owns the durable candidate, previous target,
daily deadline and report outbox. `production.ts` installs a candidate with Bun
into a fresh private prefix beside the selected executable link, with install
scripts disabled. It supplies empty account/config/state directories and a
small environment containing no inherited credentials.

The compatibility gate first uses `resolveCodexProtocol`: reviewed versions use
their pinned contracts; a newer version must extend the nearest older reviewed
stable and experimental schemas additively. It also checks the app-server
methods used by the host. Then it runs the existing
`src/lib/runtime/nativeCodexQueue.test.ts` fixture against the candidate. This
exercises initialization, thread and turn methods, native queue pagination,
mutation acknowledgements and lost-ack recovery against a local synthetic model
provider. `scripts/build-gate.ts` bundles that same test for package installs;
the probe runs from private scratch so repository test preloads cannot affect it.

Registry access has a ten-second deadline and a one MiB body bound. Installation
has two minutes, schema generation has thirty seconds per schema and the native
fixture has ninety seconds. Captured child output is bounded; a failed child
group is killed and reaped before the command returns. Preparation holds no
launch lock.

## Idle switch and rollback

Recognized POSIX installations expose a writable `codex` symlink to
`node_modules/@openai/codex/bin/codex.js`. This covers Bun's global bin and npm
package prefixes, for checkout and packaged Delegatus installs. Unknown, native,
read-only, Windows and container shim locations are reported and skipped.

Both structured Codex hosts and account clients (including voice and migration)
take the same asynchronous process-shared launch lock as the switch. Under that
lock, a fresh, bounded process inventory must show no Codex process. The scan
includes idle app-servers and native subagents and conservatively waits for Codex
processes outside Delegatus as well. An unreadable inventory refuses the switch.
The serving release rechecks its authority after the scan; no await separates
that check from the atomic executable-link rename. No running agent is stopped.

The original package is retained. Subsequent passes prune only exact prefixes
recorded by this updater, retaining the active candidate, pending candidate and
previous target. A prepared rollback record precedes the switch, so a process
that dies after rename reconciles the installed link on its next pass.

For one-step rollback, from the installation root run:

```sh
bun dist/gate/codex-update.ts rollback "$(command -v codex)"
```

Rollback uses the same idle gate. If agents are present, it persists the request
for a later scheduler pass. The rejected release stays held; daily checks can
still admit a subsequent newer release. Rollback refuses an externally replaced
executable link and preserves that replacement.

## Reporting and verification

Success and refusal each produce one short lifecycle notice for every currently
designated seat. Probe refusals name the version and either `app-server schema`
or `native queue fixture`. Durable outboxes retry journal failures using the
same event key. `codex_cli_updated` and `codex_cli_update_failed` are seat wakes
with completed and failed states respectively. Journal admission is asynchronous
and shares the existing journal's lock, sequence and idempotency rules.
When no seat is designated, the service log retains the notice.

Tests use fixture executable links exclusively. Run the updater, scheduler and
production tests by explicit path. To verify the shipped probe with a real CLI
installed only into private scratch, build the gate artifacts and run
`src/lib/codexUpdate/production.test.ts` with `CODEX_UPDATE_NATIVE_SMOKE=1`.
No performance gain is claimed.
