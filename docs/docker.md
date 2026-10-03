# Docker

## Run the published image

`ghcr.io/latand/delegatus` supports `linux/amd64` and `linux/arm64`.
`edge` tracks main; release tags provide versioned images and `latest`.
From a repository checkout, select the image, pull it, and start a test Viewer
on `127.0.0.1:8901`:

```bash
export DELEGATUS_IMAGE=ghcr.io/latand/delegatus:edge
docker compose --profile test pull viewer-test
docker compose --profile test up -d --no-build viewer-test
```

Set `DELEGATUS_UID`, `DELEGATUS_GID`, and `DELEGATUS_DOCKER_GID` for your host
when their defaults differ. Compose passes the host `HOME` and mounts it at
the same path. The image's build-time home is only the default for its `node`
account; the published target supplies a runtime passwd entry for Compose's
`HOME` and UID/GID. Host CLI shims use that runtime home. For a production
instance, follow [Production instance](#production-instance) with the same
image override. The runtime host still builds each Viewer release locally from
its exact revision.

The npm/bunx CLI includes its own supervised runtime host, so pipelines and the
orchestrator do not require Docker. Compose keeps a separate production
ownership model: the `runtime-host` profile owns the stable listener, journal,
deployment coordinator, and socket configured below. CLI supervision does not
change this profile.

The Docker image pins Node 22 and builds the Next.js app inside the image from a clean environment. It keeps the viewer host-coupled by design: Compose uses the host network, host PID namespace, privileged `nsenter` shims, the runtime user's home tree, and the host tmux socket.

Runtime tools are split by coupling. The image owns stable runtimes: Node 22, Git, GitHub CLI, OpenSSH client, curl, CA certificates, Python 3, and a faster-whisper venv at `/opt/llv-whisper-venv`. Compose mounts the full host home at its original path, so SSH keys, Git config, GitHub CLI auth, Claude/Codex state, app cache, Hugging Face cache, and workspace roots line up with host paths.

Host developer CLIs run through `nsenter` shims in `/usr/local/bin`, ahead of mounted user bins in `PATH`. The shims enter the host mount and PID namespaces, use the caller uid/gid, preserve host-visible cwd values, and fall back to `$HOME` for container-only paths such as `/app`. They execute the exact host paths: `claude`, `codex`, and `bun` from `$HOME/.bun/bin`; `uv` from `$HOME/.local/bin`; `just`, `tmux` and `tailscale` from `/usr/bin`. `LLV_DOCKER_NSENTER_SHIMS=1` also makes direct Claude/Codex resolver calls, and the Setup guide's phone step, choose `/usr/local/bin` shims. The image contains the app, Node dependencies, the local transcription helper script, and the prebuilt `.next` output.

## Production instance

Runtime-host owns production releases and the stable listener on
`127.0.0.1:8898`. Docker owns the current and rollback Viewer containers on
candidate ports. Complete the bootstrap migration below before activating
runtime-host.

Compose reads the app dir from `DELEGATUS_CONFIG_DIR`. An install from before
the rename keeps its data in `~/.config/agent-log-viewer`; the socket, journal,
and release-target paths must keep that spelling. Without the override Compose
defaults to `~/.config/delegatus`.

Select and pull the published image for both bootstrap services. Keep
these exports in every shell that runs the Compose commands; otherwise Compose
selects its local image tag and may use a different app dir. Use a version
tag instead of `edge` to pin the bootstrap image to a release.

```bash
export DELEGATUS_CONFIG_DIR="$(bun scripts/app-config-dir.mjs)"
export LLV_DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
export DELEGATUS_IMAGE=ghcr.io/latand/delegatus:edge
docker compose --profile legacy-viewer-migration --profile runtime-host pull viewer runtime-host
```

### Bootstrap listener ownership

Keep the legacy Viewer serving port 8898 while the first managed release is
prepared. Skip this command when the legacy service is already running:

```bash
LLV_ALLOW_LEGACY_VIEWER=1 docker compose --profile legacy-viewer-migration up -d --no-build viewer
```

Run the one-time bootstrap action from the pulled runtime-host image. The action
resolves `origin/main` from the canonical mirror, builds and starts a candidate
on an available alternate port, runs the full health gate, and atomically
writes `state/viewer-release.json`. It retires the candidate when verification
fails and leaves the legacy listener in place. Compose `run` has no
`--no-build` option; the preceding pull supplies its image, and `--pull never`
keeps this bootstrap invocation on that local copy.

```bash
printf '%s\n' '{"revision":"origin/main"}' | \
  docker compose --profile runtime-host run --rm -T --pull never \
    -e LLV_DEPLOYMENT_ADAPTER_PROTOCOL=1 \
    runtime-host \
    bun-container run scripts/runtime-host-viewer-adapter.ts bootstrap-release
test -s "${LLV_VIEWER_DEPLOY_TARGET:-$DELEGATUS_CONFIG_DIR/state/viewer-release.json}"
```

The bootstrap action refuses to replace an existing target. After it returns a
healthy candidate and the target-file check succeeds, stop and remove the
legacy container. This frees port 8898 for runtime-host while the managed
candidate continues serving on its alternate port.

```bash
docker compose --profile legacy-viewer-migration stop viewer
docker compose --profile legacy-viewer-migration rm -f viewer
```

Activate runtime-host and verify the stable listener:

```bash
LLV_RUNTIME_EVENTS=1 LLV_VIEWER_DEPLOYMENTS=1 docker compose --profile runtime-host up -d --no-build runtime-host
curl --fail --silent --show-error http://127.0.0.1:8898/ >/dev/null
scripts/rebuild.sh
```

Use `scripts/rebuild.sh` for every production Viewer release. Runtime-host
serializes the request, verifies the candidate, and switches its listener
target. Inspect the owner with
`docker compose --profile runtime-host logs -f runtime-host`.

Run that command from any checkout of the repository, a worktree included, with
nothing wrapping it and no `git pull` before it: it posts a revision, and the
runtime host builds that revision from its own canonical Git mirror rather than
from the working tree (#1309). With no argument and no `LLV_DEPLOY_REVISION`
override it resolves the canonical `refs/heads/main` tip and deploys that exact
commit; a full 40-character commit SHA in either case pins a redeploy or a
rollback and is posted lowercase.

The command authenticates both admission and status reads with the install's
existing `controller` service tag. It also reads the Viewer's access key when
that perimeter is enabled. Run it as the install's host user, with the same
`XDG_CONFIG_HOME` or `LLV_STATE_DIR` as the Viewer. It creates no credential and
requires no member cookie. Credentials stay inside the HTTP client; it resolves
and checks the loopback destination, pins that address and refuses redirects.
`LLV_DEPLOY_IDEMPOTENCY_KEY` still claims the original receipt after an uncertain
request. Busy admission exits 2; a successful terminal deployment exits 0.

### Bootstrap the runtime host onto a new revision (#1216)

`scripts/rebuild.sh` replaces the runtime-host generation only in the
`host-handoff` phase, which is downstream of `promoting`. A defect in the
promote path therefore pins the runtime host to the revision that carries the
defect: every later deployment runs the old promote code, fails in the same
place, rolls back, and never reaches the staging that would have installed the
fix. `scripts/bootstrap-runtime-host.ts` is the way out. It stages the same
#518 successor from a chosen revision without a deployment, so no promote has
to have succeeded first.

Run it on the host, from a checkout, with `bun`. The default mode renders the
plan and changes nothing:

```bash
bun scripts/bootstrap-runtime-host.ts            # plan only
bun scripts/bootstrap-runtime-host.ts <sha>      # plan a pinned revision
```

The plan names the target revision and image, the successor container it will
create, the predecessor container it is replacing, and — for a hand-over — the
one container it will stop. It also states what it never stops: Viewer release
containers, the structured and engine hosts inside them, and every live agent
session, pipeline, and orchestrator they own.

Read the plan, then choose how far to go:

```bash
bun scripts/bootstrap-runtime-host.ts --stage      # build and stage; stop nothing
bun scripts/bootstrap-runtime-host.ts --hand-over  # also stop the predecessor
```

`--stage` builds the image from a clean canonical worktree and creates the
successor container. The successor is *parked* on the singleton fence — it
waits there with no deadline, so it neither times out nor restart-loops — while
the predecessor keeps serving and the durable release record is repointed.
Nothing is stopped and there is no window to beat: the hand-over can follow
minutes or hours later and resumes that same container.

A successor staged by a *deployment* keeps the bounded #518 wait instead. There
the predecessor has already been asked to exit, so a bound on the wait is what
makes a wedged hand-over visible.

`--hand-over` performs the staging and then stops the predecessor runtime-host
container so the successor acquires the fence. `127.0.0.1:8898` is unserved for
the length of that exit; the run waits for the fence and names what it saw if
it never arrives. A managed predecessor remains stopped as the bounded rollback
target after the successor proves its startup and framed serving evidence.

After a host-only bootstrap the runtime host runs a newer revision than the
published Viewer release, so its boot-time MCP reconcile logs
`runtime-host MCP revision differs from the active Viewer release` and leaves
the published runtime unchanged. That is expected; the next successful
`scripts/rebuild.sh` brings the Viewer release up to the same revision.

The Compose `viewer` service exists only for the one-time listener migration. Its
`legacy-viewer-migration` profile and `LLV_ALLOW_LEGACY_VIEWER=1` launch grant
must both be present.

### Personal workstation: token-free localhost, authenticated tailnet

Once `LLV_TOKEN` is configured, the Viewer authenticates every connection,
loopback included (#1496). On a shared host that is the whole point. On a
personal workstation it means the operator's own browser at
`http://127.0.0.1:8898/` gets a 403, while the same port is also where
Tailscale Serve delivers the tailnet, so the Viewer cannot tell the two apart
from the connection: both arrive from 127.0.0.1, and `Host` or `X-Forwarded-*`
say only what the caller wrote (#1547).

Runtime-host can split the stable listener into two entries, decided by which
listener the kernel accepted the connection on:

- the **remote entry**, a second loopback port for Tailscale Serve to target.
  It is the same raw pipe port 8898 has always been, so the Viewer's own gate
  (cookie, bearer, `?k=` link) keeps authenticating it;
- the **local entry**, port 8898 itself, which once marked trusted forwards
  each request whose `Host` names loopback with the release's own credential.
  A DNS-rebound page in the browser reaches the same port with the attacker's
  `Host` and is not vouched for; the Viewer's gate refuses it as before.

Nothing changes without the gateway file, and the Viewer image, `src/proxy.ts`
and the CLI's `--tailscale` path are untouched. The file lives in the state
directory beside `viewer-release.json`:

```json
{ "remoteEntryPort": 8897, "localEntry": "trusted" }
```

Whether port 8898 is the raw pipe or the local entry is read once, when a
runtime-host generation boots. `localEntry` is read again on every request, so
trust is granted and withdrawn by editing the file, with no restart. A file
that cannot be read as this configuration — unknown key, unknown value, a
remote port equal to the local one, malformed JSON — counts as absent at boot
and as `"authenticated"` per request, and the boot log names the reason.

**Setup**, on a host whose runtime-host image carries this change. Order
matters: the tailnet moves to the authenticated entry before the local entry
is trusted, so no remote traffic ever reaches a token-free listener.

```bash
state="${XDG_CONFIG_HOME:-$HOME/.config}/agent-log-viewer/state"

# 1. Name the remote entry only. The local entry stays authenticated.
printf '%s\n' '{ "remoteEntryPort": 8897 }' > "$state/viewer-gateway.json.next" \
  && mv "$state/viewer-gateway.json.next" "$state/viewer-gateway.json"

# 2. Boot a runtime-host generation on this image (see the host-only bootstrap
#    above). Its log reports: viewer gateway: local entry 127.0.0.1:8898 is
#    authenticated at boot (re-read per request); remote entry 127.0.0.1:8897
docker compose --profile runtime-host logs --tail 20 runtime-host

# 3. Point the tailnet at the remote entry and confirm it still authenticates.
#    Only the https=443 handler changes; other serve/funnel handlers stay.
tailscale serve --bg --https=443 http://127.0.0.1:8897
tailscale serve status
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:8897/   # 403

# 4. Trust the local entry. Effective on the next request.
printf '%s\n' '{ "remoteEntryPort": 8897, "localEntry": "trusted" }' > "$state/viewer-gateway.json.next" \
  && mv "$state/viewer-gateway.json.next" "$state/viewer-gateway.json"
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:8898/   # 200
curl --silent --output /dev/null --write-out '%{http_code}\n' -H 'Host: attacker.example' http://127.0.0.1:8898/   # 403
```

The credential the local entry vouches with is the promoted release
container's, read from its Compose snapshot under
`state/deployments/compose/`; a release published before snapshots existed
falls back to the runtime-host container's own `LLV_TOKEN`. If neither names
a token the entry stays authenticated and logs it once.

**Rollback.** Withdrawing trust is one file edit and takes effect on the next
request; removing the gateway entirely takes a host restart because the
listener kind is chosen at boot.

```bash
# Withdraw trust only: 8898 authenticates again, the tailnet keeps working.
printf '%s\n' '{ "remoteEntryPort": 8897 }' > "$state/viewer-gateway.json.next" \
  && mv "$state/viewer-gateway.json.next" "$state/viewer-gateway.json"

# Full rollback: tailnet back on 8898, gateway file gone, host generation restarted.
tailscale serve --bg --https=443 http://127.0.0.1:8898
rm "$state/viewer-gateway.json"
```

Under the Bun the image pins (1.4.0) the local entry relays Upgrade requests
and tears down a Viewer stream whose reader went away; Bun 1.3.3's node:http
does neither, which is one more reason the runtime host runs only under the
pin. On a shared host, leave the file absent.

### Phone access from the Setup guide

The Setup guide's phone step runs the host's own `tailscale` through the
`/usr/local/bin/tailscale` shim, so it reads the host's tailscaled and its
button publishes with `tailscale serve --bg` the way it does on a plain
checkout. Three things differ, because the Viewer here is a release container
on a per-deploy candidate port behind the runtime host:

- The tailnet is pointed at the runtime host's entry, which outlives every
  deploy: the gateway's remote entry when one is bound, otherwise the stable
  port. The ports come from `state/viewer-entries.json`, which the runtime host
  writes once its listeners are up, so a moved stable port or a gateway file
  edited after the host booted never sends the tailnet to a port nothing
  listens on. A stable port that is a trusted local entry with no bound remote
  entry is refused with `TRUSTED_ENTRY`: that port vouches for
  loopback-addressed requests, and the tailnet is never pointed at it.
- A key the container already holds (`LLV_TOKEN` from `service.env`) is the
  key the link carries, and turning phone access off keeps it. The trusted
  local entry and the MCP clients vouch with that same key.
- With no key in `service.env`, a release gates on the key file once phone
  access is on. The deploy adapter's health probes, the staging deploy's
  probes and the trusted local entry then carry the key file's key, so
  deploys keep passing their probes.
- A staging Viewer (`LLV_STAGING=1`) shares the flag, the key file and the
  host's tailscaled with production, so its phone step only reads: turning
  phone access on or off there is refused with `STAGING`.
- Turning phone access off while Tailscale publishes a different port keeps
  the remembered choice (`SERVING_OTHER`): the Viewer on that port shares the
  flag and would otherwise start ungated under its live mapping.
- Nothing like the launcher runs before `next start`, so the Viewer puts the
  gate back itself at boot, before its first request, whenever the
  `phone-access` file is present: it keeps the key the environment set or
  reads the key file beside the flag, then restores the link if Tailscale runs
  and the mapping points at this install. Any `phone-access` file counts,
  whatever it holds, and the press writes it with a rename, so it is never
  seen half-written. If the key cannot be put in place,
  the Viewer exits with status 78 rather than serve the live mapping ungated;
  fix the key file or remove the `phone-access` file to turn phone access off.

## Agents reach the Delegatus MCP tools over HTTP

By default every spawned agent starts its own `bin/mcp-server.mjs` over stdio,
a Bun process (plus a file-scan worker once it reads transcripts) per agent.
The Viewer also serves the same tools at `/api/mcp` on its own port, over
Streamable HTTP, statelessly. Each agent is identified by the per-launch spawn
capability the Viewer already gives it (`LLV_SPAWN_CAPABILITY`), presented in
the `x-llv-spawn-capability` header; the registry holds only its digest, and a
relaunch rotates it. A request without a capability the registry recognises is
refused. The capability is identity only: reaching `/api/mcp` takes what every
other route takes, so with `LLV_TOKEN` configured an agent gets through only by
way of the stable local entry on 8898 while `viewer-gateway.json` trusts it
(the entry supplies the key for loopback callers).

To move new spawns to the shared endpoint, set the flag in `service.env` and
remove the Viewer-managed Codex accounts' own `viewer` registration:

```sh
echo 'LLV_MCP_TRANSPORT=http' >> ~/.config/agent-log-viewer/service.env
LLV_MCP_TRANSPORT=http scripts/install-mcp.sh
```

Claude spawns need nothing else: the Viewer writes their whole `--mcp-config`,
pointing `viewer` at `http://127.0.0.1:8898/api/mcp` with the header taken from
the agent's own environment, so the file holds no secret. Codex layers a
thread's configuration over `config.toml` key by key, so whatever an account
registers wins: a registered `command` cannot take a `url`, and a registered
`url` cannot be turned back into a launcher. The script therefore removes the
registration from the Viewer-managed Codex accounts, and the Viewer writes the
`viewer` server into each thread itself, over HTTP or as the stdio launcher
per launch. The URL is the stable listener, so a deploy changes nothing on the
agent side: a call made while the releases swap fails, and the next one
reaches the new release. Agents already running keep the transport they were
launched with. The seat monitor reads the effective transport recorded on the
launch receipt, including an HTTP request that fell back to stdio at admission;
the current server flag does not change health checks for an existing seat.
Older receipts without that field are checked as stdio. Removing the flag alone
takes new spawns back to stdio; run the
script with `LLV_MCP_TRANSPORT=stdio` to register the launcher again for Codex
sessions started outside Delegatus.

A Viewer launch stays on stdio whatever the flag says when the shared endpoint
could not serve it: its environment carries no capability (a Claude command
pasted into a terminal by the attach/resume flow, a host the registry cannot
match), or `LLV_TOKEN` is configured and the local entry is not trusted. A Codex
session started outside Delegatus with an account whose registration the
script removed has no Delegatus tools until the script is run with
`LLV_MCP_TRANSPORT=stdio`.

The gate is read at each launch from the running Viewer, so a key put in place
later — phone access turning on the key file — sends the next launches back to
stdio unless the local entry is trusted. An agent already running over HTTP at
that moment reaches the Viewer only through a trusted local entry, which on the
Docker shape is what carries the key file's key.

## Moving off the systemd install

Docker is the only install. The systemd user units an earlier install set up,
`agent-log-viewer.service` and `agent-log-viewer-legacy-tmux.service`, are
retired, and the repository no longer ships or installs them. When either unit
file is still in `~/.config/systemd/user`, the `delegatus` CLI prints this
migration at start and then starts as usual; it never stops a unit itself.

Stopping `agent-log-viewer-legacy-tmux.service` ends every tmux session it
hosts, so finish the agents in those panes first. Then stop and remove the
units and install with the production instance steps above:

```bash
systemctl --user disable --now agent-log-viewer.service agent-log-viewer-legacy-tmux.service
rm -f ~/.config/systemd/user/agent-log-viewer.service ~/.config/systemd/user/agent-log-viewer-legacy-tmux.service
systemctl --user daemon-reload
```

## Attach to a Viewer pane

Use the attach command Delegatus copies for a live pane. It includes the configured endpoint and the pane's current display target. For example:

```bash
TMUX_TMPDIR='/tmp' tmux attach-session -t 'agents:2.0'
```

For an observation-only terminal, use the read-only form:

```bash
TMUX_TMPDIR='/tmp' tmux attach-session -r -t 'agents:2.0'
```

Detach with `Ctrl-b d`; the pane and its agent continue running. The endpoint prefix is required because an unqualified `tmux attach-session` can select another tmux server. If the Viewer reports that the pane changed or the tmux server restarted, refresh the page and copy a newly resolved command. Window renumbering is handled when the command is copied.

## Test instance

Use the test profile for local validation on another port:

```bash
LLV_TEST_PORT=8901 docker compose --profile test up --build viewer-test
```

This reuses the same image and mounts, with the service listening on `127.0.0.1:$LLV_TEST_PORT` through host networking, so no Compose port mapping is used.

To exercise the ChatGPT transcription backend in Docker, pass the backend override through Compose:

```bash
LLV_TEST_PORT=8901 LLV_TRANSCRIBE_BACKEND=chatgpt docker compose --profile test up viewer-test
```

## Mounted paths

Compose mounts the whole host home:

- `/home/user:/home/user`

This gives the scanner and spawn validation the same paths the host service sees, including:

- `/home/user/.claude/projects`
- `/home/user/.codex/sessions`
- `/home/user/.claude.json`
- any cwd under `/home/user`, such as `.agents`, `Projects`, `Documents`, `Downloads`, `Desktop`, and `remote`

Additional runtime mounts keep host sockets reachable:

- `/tmp/tmux-1000`
- `/tmp/claude-1000`

If the host uid differs, run with `LLV_UID` and `LLV_GID` set and make sure the matching `/tmp/tmux-$LLV_UID` and `/tmp/claude-$LLV_UID` paths exist.

## Agent memory limits

Docker uses the RSS watchdog for agent process trees; migration through the
host user manager is deferred. Configure `DELEGATUS_AGENT_MEMORY_MAX` and
`DELEGATUS_AGENT_MEMORY_RESERVE` in the Viewer environment, and recreate the
container at the next planned update to apply them. Defaults reserve at least
4 GiB and 15% of RAM for the OS and core, and size each agent at launch.

The watchdog samples every two seconds, checks PID start identities and kills
the largest process when a tree or the shared agent budget exceeds its limit.
One interval of growth can overshoot, double-forked descendants can escape,
swap is unbounded, and kernel OOM kills lack attribution. Agents inherit an OOM
score of at least 500; the container restart policy still handles a dead core.
`DELEGATUS_AGENT_MEMORY=off` disables isolation. See the
[agent memory design](design/agent-memory-isolation.md) for the systemd drop-in
needed by an existing host user-service install.
