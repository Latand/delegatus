# Keeping Delegatus running and up to date

This page covers updates, automatic updates, running a checkout under a user
service, the memory and CPU limits for agents, and moving memory and settings
to another install. Docker has its own runbook,
[docs/docker.md](../docker.md).

## Updates

**Updates** in the sidebar's ⋯ menu builds the selected green revision in a separate
release directory, then replaces and verifies the launcher, web server and
runtime host together. If verification fails, the launcher restores the previous
release. Running sessions reconnect and interrupted work resumes.

### When the launcher needs a restart

If an older launcher needs upgrading, the Update dialog offers **Restart
launcher** for the user service that runs it, naming that service, or the exact
command for its terminal. Packaged installs download a published release into
the user's cache, so no global installation permissions are needed.

### Older packaged releases

Packaged releases that predate this updater need one launch of
`bunx delegatus-cli@latest` to load it. The Update dialog installs a published
version that names the commit it was packed from; for a version published
without one (every version up to 1.9.0) it names the version and asks for
`bunx delegatus-cli@latest`.

## Automatic updates

**Automatic updates**, off by default, waits for green checks and a quiet
moment. On a busy machine it holds new launches while the current work
finishes, then applies the update. If the work does not finish in time, the
update waits and tries again later. The Update dialog and `auto_updates` show
the reason and the retry time. Your own activity, low memory and failing checks
still block it. A failed automatic apply rolls back and turns the switch off.

Automatic updates are available for a clone or a Docker runtime-host
install. A packaged install updates through the Update dialog instead.

## Running as a user service

A checkout launcher may also run under a user systemd service. The Update dialog
restarts an older launcher through a transient service outside the unit being
restarted. Obsolete `agent-log-viewer` units still produce the migration notice;
[docs/docker.md](../docker.md#moving-off-the-systemd-install) describes retiring
those units.

## Agent memory and CPU

Delegatus keeps agents from starving the Viewer, and both limits work without
setup on a supported Linux install.

- **Before a launch.** An agent starts only when at least 2 GiB of RAM is
  available. A refusal reports the measured RAM and the required floor, and the
  board and the pipeline's failure handling show it as a failed launch.
- **While it runs.** Each agent gets a memory ceiling computed from RAM and the
  number of live agents, and the Viewer keeps at least 4 GiB (15% of RAM) for
  itself and the system. `DELEGATUS_AGENT_MEMORY=off` turns the ceiling off.
- **When one runs out.** A recorded out-of-memory kill raises a **Needs you**
  item naming its stage and limit for 24 hours. A fatal stage kill retries once
  after memory recovers and keeps its worktree. A second consecutive kill, or a
  30-minute wait without recovery, stops for a decision.
- **CPU.** Agents you talk to get the larger CPU share. Pipeline stages,
  reviews, gates, publication and release builds share a smaller slice. A stage
  waits while the CPU is busy and starts when it has been quiet for ten seconds;
  the wait shows in the pipeline's detail line, and a queue that has started
  nothing for too long says so on the card. Your own messages never wait.
- **Docker and macOS.** A watchdog enforces the memory limit instead of the
  system's service manager. Native Windows leaves memory isolation off.

An install that runs as a user service needs one setting so a killed agent does
not take the service down. [Agent memory and CPU limits](../agent-resource-limits.md)
has the drop-in, the environment variables and the details.

## Docker

The published image, the production instance with its runtime host and the
test profile are in [docs/docker.md](../docker.md). The Docker image uses the
same limits above; memory in Docker is enforced by the watchdog.

## Moving to another install

`delegatus export` writes this install's Delegatus memory and core settings to
one bundle: learned rules with their history, memory profiles, call memory,
seat tick settings, role overrides, worker limits, project settings, operator
settings, voice choices, the App repository declaration and relay switches.
No login, key, token or pairing is ever in it. Engine memory (Claude project
memory, Codex memories) is not carried: switch the install to Delegatus memory
first, which imports it ([memory source switch](../design/memory-source-switch.md)),
and the export says so when some was never imported.

```
delegatus export                         # sealed; the passphrase is shown once
delegatus import delegatus-transfer-2026-10-22.dlgt --dry-run
delegatus import delegatus-transfer-2026-10-22.dlgt --map dir-…=/path/on/this/install
delegatus export --plain - | ssh server delegatus import -
delegatus import --report
```

Both commands talk to the running Delegatus on this machine and refuse when
it is not running. The dry run lists, per section, what is new, already
there, in conflict (this install's value stays unless `--replace` names the
section) or skipped, and every folder that needs a folder here. Apply writes
nothing when this install changed since the dry run, and leaves the install
as it was when it fails or stops partway. The report compares each learned
rule scope with the source and lists what still has to be done here: signing
in each account, API keys through Keys → Import, the relay pairing, the
GitHub App credential, and the environment variables the source used. The
design is [docs/design/install-memory-transfer.md](../design/install-memory-transfer.md).
