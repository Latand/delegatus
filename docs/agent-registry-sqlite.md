# Agent registry storage

The agent registry lives in `agent-registry.sqlite` (WAL, `synchronous=FULL`).
There is no JSON mirror (#1870). Nothing in the product reads or writes
`agent-registry.json` once the store is initialised.

## Mode resolution

`LLV_AGENT_REGISTRY_SQLITE` still accepts four values, and SQLite is the
default:

- unset, or `sqlite`: the registry reads and writes `agent-registry.sqlite` only.
- `off`, `dual-write`, `read`: the JSON-authoritative modes of the original
  rollout. They run only when named explicitly, log a deprecation warning, and
  go away with the rest of the legacy import path under #1872.

A process that has no variable (the MCP server that Claude launches with an
empty environment, an npm install) resolves the published descriptor
`agent-registry.backend.json`, and with no descriptor it uses SQLite. A writer
that resolved its mode publishes the descriptor, so every process opens the
same store. An unreadable, contradictory or unavailable identity still fails
closed.

Every process that opens the registry runs on Bun. The Docker Viewer uses
`bun-container --bun`; for a source checkout, launch Next with
`bun --bun node_modules/.bin/next start`.

## First boot of a JSON install

An install whose authority is still the JSON file (a descriptor that says `off`
or `dual-write`, or no descriptor and only `agent-registry.json` on disk)
migrates itself on the first open:

1. The opener takes the JSON's own write lock, which every JSON-mode writer
   also takes, and re-reads the descriptor. A concurrent opener that already
   finished leaves nothing to do.
2. A store that already holds an import beside the authoritative JSON is an
   earlier experiment. The trio is set aside as
   `agent-registry.sqlite.stale-<time>` (with its `-wal` and `-shm`), which is
   the old manual rebaseline, automated.
3. The JSON is imported in one `BEGIN IMMEDIATE` transaction. Before `COMMIT`
   the rows are read back and their entity count and content digest are
   compared with the file. A mismatch rolls the import back: the store stays
   unmarked and the JSON untouched.
4. The JSON is renamed to `agent-registry.json.imported-<release>` and kept for
   one release.
5. The descriptor is published as `sqlite`, last.

A crash at any step leaves the next open to finish. If it happens after the
rename, the descriptor still names the JSON, the JSON is gone and the store
holds the import, so the next open only publishes.

## A deployment that is already on SQLite

The first start of this release finds the 63 MB mirror an older release wrote
and renames it to `agent-registry.json.imported-<release>` without reading it.
It also removes the JSON-era `agent-registry.json.write-lock.owner.pending-*`
directories and `retired-*` links whose recorded owner process is gone.

The per-session operation locks under `agent-registry.json.locks/` stay where
they are. Two releases overlap during a hand-off and must contend on the same
lock directory; the name is historical.

Managed releases pass the configured mode to the candidate and to the
runtime-host successor. An unset Compose value is sent as `sqlite`, the
candidate's deployment capability reports its configured mode, and
candidate health fails when the two differ.

## Rollback and downgrade

A rollback to a release older than this change runs with the same environment,
in `sqlite` mode. It finds no mirror, writes one at its start as it always did,
and keeps working from `agent-registry.sqlite`. Rolling forward again renames
that mirror away. Nothing is lost in either direction, because SQLite is the
store both releases write.

An npm install downgraded to an older version that reads the backend
descriptor keeps working the same way: the descriptor says `sqlite`, so it opens
the store. A version from before the descriptor existed would open an empty
JSON registry instead.

Do not roll back by setting `LLV_AGENT_REGISTRY_SQLITE=off`. The JSON file is
gone, so an `off`-mode process would start from an empty registry, and restoring
the kept copy would lose every change made since the migration. The `off`
rollback procedure of the original rollout is retired.

`/api/files` reports the backend mode, the revision, the transaction count, and
the transaction and writer-wait p95 under `systemHealth.registry`. In `sqlite`
mode the mirror fields are null.
