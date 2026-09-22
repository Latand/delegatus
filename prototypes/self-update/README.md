# Self-update prototype

A standalone page that shows how an Agent Log Viewer install updates itself
and restarts its two processes separately. It is **not** wired into the
Viewer: it manages one install of its own — a git checkout, an isolated
config root, that checkout's web process and its runtime host — and nothing
else. Design: [`docs/design/self-update.md`](../../docs/design/self-update.md).
Issue #2007.

What the page does:

- **Update available.** Every poll interval (60 min by default) and on
  *Check now*, `git ls-remote` against the remote, compared with the
  installed release. When the tip differs it fetches the tip into
  `refs/self-update/tip` (no branch or working-tree change) and shows the
  commits between the two revisions (merges left out) and the `CHANGELOG.md`
  entries the tip adds. A check that fails is shown as failed, never as up to
  date.
- **Update.** Five steps, streamed live: fetch, check out the exact tip SHA
  into its own release directory (`git worktree add` under
  `<config-root>/self-update/releases/`), `bun install --frozen-lockfile` and
  `bun run build` there, ready. Only a ready build becomes the installed
  release (`<config-root>/self-update/release.json`). The first failure stops
  the sequence and offers *Retry from <step>*. Nothing is restarted, and
  nothing is written where a running process serves from: both keep serving
  the previous release, whole, until you restart them onto the new one.
- **What runs.** The header shows what the live processes serve (per process
  when they differ), the built release while it is not running yet, and the
  available one. It turns green only when every live process runs the
  newest build.
- **Restart web / Restart runtime host.** Two separate actions. The runtime
  host restart drops the agents it supervises, so it asks for an inline
  confirmation first. Every stop signals the process group of a PID the
  prototype (or the bench) recorded when it started that process, after
  checking the PID still carries the recorded `/proc` start identity.

## How the seat starts the bench for the operator

The bench builds a duplicate install one release behind and points the
prototype at it. Use the pinned Bun: the system Bun 1.3.3 cannot serve a
build.

```sh
free -m                                   # needs 4 GB available; one heavy command at a time
~/.cache/llv-bun-1.4.0/bin/bun prototypes/self-update/bench.ts start
```

It clones this repository to `/var/tmp/llv-self-update-bench/checkout`, sets
its `origin` to the canonical GitHub remote, checks out `origin/main~5` (or
`--at <sha|tag>`, for example `--at v1.2.2`), runs `bun install` and
`bun run build` under the isolated config root
`/var/tmp/llv-self-update-bench/config`, starts the runtime host and the web
process on a free port, then starts the prototype on another free port. It
takes a few minutes (the Next build) and ends by printing:

```
  Viewer (older):   http://127.0.0.1:<web port>/
  Self-update:      http://127.0.0.1:<prototype port>/
```

Send the operator the **Self-update** link. Their path through it: the page
opens on *Update available* with the changelog summary → *Update* → watch the
five steps → *Restart web* → *Restart runtime host*, confirm → both blocks
return to *healthy*; the Viewer link then serves the new version.

```sh
~/.cache/llv-bun-1.4.0/bin/bun prototypes/self-update/bench.ts status   # PIDs and URLs
~/.cache/llv-bun-1.4.0/bin/bun prototypes/self-update/bench.ts restart-prototype   # after editing the prototype; web and host keep running
~/.cache/llv-bun-1.4.0/bin/bun prototypes/self-update/bench.ts stop     # stops every recorded PID
~/.cache/llv-bun-1.4.0/bin/bun prototypes/self-update/bench.ts stop --purge   # …and removes the bench directory
```

Each update leaves a release directory with its own `node_modules` and
`.next` (about 1.8 GB here) under `config/self-update/releases/`; nothing prunes
them yet, and `stop --purge` removes them with the rest.

`bench.json` in the bench root holds the ports and the PIDs with their start
identities. `stop` signals the prototype first, then the web and runtime-host
records (the ones the bench started and any the prototype's restarts replaced
them with). Logs: `config/self-update/logs/{web,runtime-host}.log`,
`config/self-update/steps/<step>.log`, `logs/prototype.log`.

## Isolation

- The config root must sit under `/tmp` or `/var/tmp` (or pass
  `--allow-any-root`), and anything under `~/.config` is refused outright.
- Every child runs with the inherited `LLV_*`, `NEXT_*`, `__NEXT_*`,
  `NODE_ENV`, `PORT`, `HOSTNAME` and `TMPDIR` removed, and with
  `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `LLV_STATE_DIR`, `TMPDIR` and the
  runtime-host socket, fence and journal pointed under the config root.
- The production Viewer ports are refused as `--web-port`; the prototype binds
  `127.0.0.1` only and never touches Docker.
- `safety.test.ts` fails if any file here finds a process by name, pattern or
  port.

## Running the prototype against another install

```sh
~/.cache/llv-bun-1.4.0/bin/bun prototypes/self-update/server.ts \
  --checkout <dir> --config-root /var/tmp/<root> --web-port <n> \
  [--port <n>] [--remote <url>] [--branch main] [--poll-minutes 60] [--bun <path>]
```

Each flag has a `SELF_UPDATE_*` environment twin (`--help` lists them). On
start it adopts web and runtime-host records left in
`<config-root>/self-update/processes.json` whose PIDs still carry the recorded
start identity; stopping the prototype leaves both processes running. Every
start and restart runs from the installed release as it stands then: the
checkout until an update publishes one.

## Tests and frames

```sh
B=~/.cache/llv-bun-1.4.0/bin/bun
for f in lib/changelog lib/git lib/steps lib/processes server safety; do
  $B test ./prototypes/self-update/$f.test.ts
done
CHROME_BIN=google-chrome-stable $B prototypes/self-update/capture.ts \
  --url http://127.0.0.1:<prototype port>/ --out /var/tmp/llv-self-update-frames --name <state>
```

The tests need no network: the update check runs against a local bare
repository, the step runner against a stubbed command, the process supervisor
against a stub child. `capture.ts` writes PNG frames outside the repository
(browser captures cannot be committed here) and a `geometry.json` with the
overflow, clipped-button and overlapping-text measurements per frame.
