# Staging deployment target (#659)

The delivery flow is builder → merge to `stage` → **staging deploy** →
operator review on staging → promote to `main` → prod deploy. The staging
instance serves the `stage` branch beside prod so the operator can browse
both at once.

## Ports on this host

| Port | Owner |
| --- | --- |
| `127.0.0.1:8898` | Prod front proxy (runtime-host `deploymentProxy`) |
| `127.0.0.1:8899` | **Staging viewer (fixed; this feature)** |
| `127.0.0.1:8901` | `viewer-test` compose default (`LLV_TEST_PORT`) |
| `127.0.0.1:18000–19999` | Prod blue-green candidate Viewers |

8899 was chosen because it is unused by the deploy config and free on the
host; it is now reserved for staging (older notes used it for ad-hoc local
`next start` runs — pick another port for those).

## Deploying

```sh
bun run deploy:staging                     # deploy the current origin/stage head
bun scripts/deploy-staging.ts --revision <40-hex sha>   # deploy an exact stage sha
```

Simple replace, no blue-green: the script keeps its own canonical mirror
under the staging state dir, resolves `refs/heads/stage`, builds the image
through the same Dockerfile path and `LLV_RUNTIME_HOME` build arg prod
deployments use (`agent-log-viewer:staging-<sha12>`), builds that revision's
Viewer MCP runtime and stages it under the staging state dir's
`mcp-runtime/releases`, removes the previous
`llv-staging-runtime-host` + `llv-staging-viewer` pair, publishes the staging
`viewer-release.json` and compose snapshot, starts the new pair, and gates on
`http://127.0.0.1:8899/api/staging` serving the exact deployed revision to a
caller holding the service token. A second gate resolves the Viewer control
endpoint and credential from exactly the environment a staging stage agent
inherits, the way that agent's MCP server does, and fails unless it is the
staging Viewer at the deployed revision (#1683).

Without the build arg, ssh inside the staging Viewer reads `known_hosts` from
the image's default home and every pipeline branch publish fails host-key
verification. The release target is published before the new pair starts, so
the arriving Viewer moves the hot-state authority to its own revision; the
operator's stable MCP launcher is never reinstalled from staging. Each staged
MCP runtime carries production `node_modules` (about 600 MB), so once the
gates pass the deploy keeps only the runtime the staging release target names
and the one it named before (the rollback's), and removes the other staging
runtimes. A target it cannot read prunes nothing, and it never looks outside
the staging state dir.

The deployed revision is recorded in
`~/.config/agent-log-viewer/state-staging/staging-release.json` and exposed
at `GET /api/staging`; the UI shows a fixed **Staging · <sha7>** badge.
Staging containers are labelled `dev.live-log-viewer.staging=1` — never
`dev.live-log-viewer.managed=1` — so prod retain/cleanup sweeps and
candidate-port reservation cannot touch them.

## State isolation (the hard contract)

Staging processes run with `LLV_STAGING=1` and their own state dir
(default `~/.config/agent-log-viewer/state-staging`). Everything mutable —
agent registry, runtime events journal + socket, board, pipelines, flows,
inbox, release records — resolves through `stateDir()`, and in staging mode
that resolver **throws** if it would land on the prod state dir or the
legacy `~/.claude/viewer-state` dir, and never runs the legacy migration
copy. The container builders (`src/runtime-host/stagingContainer.ts`)
re-assert the same guard and repin every release-bearing variable the compose
snapshot names for prod: `LLV_VIEWER_DEPLOY_TARGET` (the staging
`viewer-release.json`), `LLV_VIEWER_PORT` and `LLV_VIEWER_CONTROL_URL` (8899),
and `LLV_RUNTIME_JOURNAL` (the staging journal).

The pinned values are what keep agents on staging. The
structured hosts forward `LLV_STATE_DIR`, `LLV_VIEWER_DEPLOY_TARGET` and
`LLV_VIEWER_PORT` to every agent they launch, and the Viewer MCP server falls
back to `127.0.0.1:8898` when it has no port. With the pair stripped, a
staging stage agent read staging state in-process while every tool that goes
over Viewer control HTTP (`list_conversations`, `search_transcripts`,
`send_message`, `deploy_exact_sha`) reached prod (#1683), and so did the
pipeline tick its MCP server sends after a pipeline change, which read only
`LLV_VIEWER_CONTROL_URL` (#1685). Prod's stable port vouches for loopback
requests when its gateway marks the local entry trusted, so prod answered
those calls.

Agent launches stay enabled on staging (operator revision of #659, comment
of 2026-07-24): spawn, attach, migrations, pipelines and message delivery
work against staging's own registry/journal/board, so agents launched from
staging live on staging's board and never enter prod state. Transcripts are
inherently machine-global: agents spawned from staging write real
transcripts under `~/.claude` / `~/.codex`, which any viewer on the machine
(including prod) can *see* in its file feed — exactly as it sees every other
agent on the host. Prod's registry, board, events and pipelines stay
untouched.

## Verification after a stage deploy

1. **Staging serves the stage revision** —
   `curl -s -H "Authorization: Bearer $LLV_TOKEN" http://127.0.0.1:8899/api/staging`
   (the staging service inherits the compose `LLV_TOKEN`; without it the
   answer is 403) reports
   `{"staging":true,"revision":<deployed sha>,…}` matching
   `git rev-parse origin/stage` and `staging-release.json`; the UI at
   `http://127.0.0.1:8899` shows the staging badge with that sha prefix.
2. **Prod untouched** — the deploy script fingerprints (sha256 + mtime)
   prod's `viewer-release.json`, `agent-registry.json`,
   `runtime-events.sqlite`, `board.json`, `pipelines.json`, `flows.json`
   before and after, prints the diff, and **fails** if
   `viewer-release.json` changed (only deploy machinery writes it; the
   other files keep changing while live prod works — they are reported for
   the operator to eyeball).
3. **Prod still serves prod** — `curl -s http://127.0.0.1:8898/api/staging`
   reports `{"staging":false,…}`.
4. **Launches stay staging-local** — spawn an agent from the staging UI;
   it appears on staging's board (`state-staging/agent-registry.json`)
   and prod's `agent-registry.json` fingerprint stays unchanged.
5. **Agents' Viewer control lands on staging** — the deploy output's
   `agentControl` reads `origin: http://127.0.0.1:8899` and
   `authenticated: true`. The gate resolves the endpoint and credential
   through the same functions the MCP server's control calls and its pipeline
   tick use, from the variables a staging agent inherits; the in-process
   reads (`get_pipeline`, `list_pipelines`) use `LLV_STATE_DIR`, which staging
   already pinned.
