# Configuration: the command, files and environment variables

This page lists the `delegatus` command and its options, where Delegatus keeps
its data, the interface language and the environment variables. Memory and CPU
limits for agents are in [Keeping Delegatus running](operations.md#agent-memory-and-cpu).
Optional preparation before a pipeline's first builder is described in
[Project setup recipes](project-setup.md).

## The command

`bunx delegatus-cli` runs the package without installing a command. To
keep a `delegatus` command installed, run
`bun add -g delegatus-cli`; `dlg` is a short alias for the same command.
`bun add -g` installs into `~/.bun/bin` and needs no root, while
`npm install -g` does on most systems.

The command starts two processes: the web app, and the runtime host that
launches and supervises agents. Ctrl-C stops both. Delegatus listens on
`127.0.0.1` unless you pass `--hostname`, and opens the page in your browser
when it can. Set `DELEGATUS_DEBUG=1` to print startup diagnostics.

Delegatus used to be called Agent Log Viewer. The old `agent-log-viewer`
command still works and prints a one-line notice.

| Option | Description |
| --- | --- |
| `-p, --port <n>` | Port for the local server (default `8898`). |
| `-H, --hostname <h>` | Bind address (default `127.0.0.1`). |
| `--no-open` | Don't open the browser on start. |
| `--tailscale` | Serve inside your tailnet for phone access (see [Phone access](phone.md#phone-access)). |
| `--new-token` | Create a fresh access key and invalidate old cookies. |
| `--new-operator-token` | Rotate the key that authorizes launching agents. |
| `-v, --version` / `-h, --help` | Print the version / usage. |

The CLI reads the listening port from `-p` or `--port`. It does not read
`DELEGATUS_PORT` or `LLV_PORT`. The selected port is passed to its control
clients as `LLV_VIEWER_PORT`.

### Stopping everything

Agent hosts start detached, so that a running agent survives a restart of
Delegatus. Ctrl-C therefore leaves them running. `delegatus stop --all` stops
this install's launcher, which stops the web app and the runtime host. Then
it stops every agent host the agent registry records, together with the
processes under each host. **Stop Delegatus** in the app menu (⋯; on a phone,
under Settings) asks first and then runs the same stop. On a team install
only the owner sees it. Its report goes to `stop-all.log` in the state
folder, because the page stops answering soon after.

A process is stopped only when the record Delegatus wrote at its start still
matches it: the same pid, start time and boot. A web app or runtime host must
also carry this install's runtime-host socket in its own environment. A
record from before the computer last started names nothing, since a crash
can leave one behind. Nothing is chosen by name, pattern or port. The report
lists what was stopped and which recorded processes were already gone. It
also lists processes that were left running because they could not be
proven to be the ones Delegatus started. The command works on Linux and
macOS. On other platforms it stops nothing, says so, and lists the recorded
agent hosts. It exits `1` when a process it proved to be Delegatus's is
still running, a record could not be read, or a record could not be checked
from where the command runs: a sandbox with its own process namespace, or a
system whose boot cannot be read.

## Files

Delegatus keeps everything in `~/.config/delegatus/`, or under
`XDG_CONFIG_HOME` when you set it. An install from before the rename keeps
its data in `~/.config/agent-log-viewer/`, and `~/.config/delegatus` becomes
a link to it; nothing moves or gets copied.

- `state/`: tasks, pipelines, the agent registry and other state, mostly in
  SQLite.
- `accounts/`: the extra Claude, Codex and Copilot accounts you add, each
  with its own login.
- `token`, `transcribe-backend`, and API key files such as
  `elevenlabs-api-key` and `openai-api-key`.

The local dictation environment lives in `~/.cache/delegatus/whisper-venv`
(`~/.cache/agent-log-viewer/whisper-venv` on an install from before the
rename).

## Keys

**Settings → Keys** in the sidebar's ⋯ menu (the board menu's **Settings** on
a phone) holds the API keys Delegatus reads itself: OpenRouter, OpenAI,
ElevenLabs, Soniox, Fish Audio and the Telegram bot token. Each row says
whether its key is saved here, set by its environment variable (which wins and
is changed there) or not set. The eye shows a key for 30 seconds; copy puts it
on the clipboard without showing it; ⋯ copies its masked form or replaces it.
**Copy all keys** copies one `NAME=value` line per set key, and **Import
keys** on another machine reads the same lines, shows what each one would do
and writes nothing until you apply it. A key keeps the file it had: the ones
above, plus `openrouter-api-key`, `soniox-api-key` and `fishaudio-api-key`.
Only the owner of a team install can show, copy, import or change a key.

## Language

The interface speaks English and Ukrainian. Switch it under **Settings** in
the sidebar's ⋯ menu; the default follows your browser. CLI messages switch to
Ukrainian with `DELEGATUS_LANG=uk` or a `uk_*` locale.

## Environment variables

All of these are optional. Each `DELEGATUS_` variable also works under its
older `LLV_` name, and the `DELEGATUS_` one wins when both are set.

Of the variables ending in `_API_KEY`, only `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY` and
`SONIOX_API_KEY` pass on to the agents and commands Delegatus starts.

**Agent memory**

- `DELEGATUS_AGENT_MEMORY` — `auto` (default), `scope`, `watchdog`, or `off`. Auto uses systemd user scopes on supported Linux installs and an RSS watchdog in Docker and on macOS.
- `DELEGATUS_AGENT_MEMORY_MAX` — per-agent ceiling, e.g. `24G`, capped at the shared agent budget. GB means GiB.
- `DELEGATUS_AGENT_MEMORY_RESERVE` — RAM reserved for the OS and Delegatus, e.g. `24G`; default is 15% rounded up to GiB, at least 4 GiB.

**Codex paid credits**

- `DELEGATUS_CODEX_CREDIT_GUARD_USED_PERCENT` — stop using a Codex account that holds paid credits when a session or weekly window reaches this percentage (default `99`). Accepts numbers greater than `0` and less than `100`; invalid values use `99`. The guard applies to each account's reported balance, including pinned launches and queued turns. A stale guarded reading stays blocked until a fresh reading establishes headroom.

**Language and diagnostics**

- `DELEGATUS_LANG` — `en` or `uk`: the language of CLI messages.
- `DELEGATUS_DEBUG` — `1` prints startup diagnostics in the terminal.
  An install from the package bounds its event-loop diagnostics: each process
  writes `[viewer loop-gap]` reports up to 64 KiB per hour, and a
  `[performance summary]` a minute after start and then every 15 minutes,
  counting the reports it held back. `DELEGATUS_DEBUG=1` writes every line. A
  git checkout, such as a service run from a clone, always writes every line.
- `VIEWER_PROC_BACKEND` — `linux`, `portable` or `windows`: forces the process-discovery backend.

**Voice**

- `DELEGATUS_TRANSCRIBE_BACKEND` — `local` (default), `chatgpt`, `elevenlabs` or `soniox`: fixes the dictation backend and locks the microphone menu.
- `DELEGATUS_WHISPER_MODEL`, `DELEGATUS_WHISPER_DEVICE` — faster-whisper model size (default `small`) and device (`cpu`, the default, or `cuda`).
- `DELEGATUS_TTS_BACKEND` — `openai`, `elevenlabs` or `soniox`: fixes the read-aloud provider.

**Cleanup and lifecycle**

- `DELEGATUS_HOST_RETIREMENT_IDLE_HOURS` — how many hours a hosted agent's transcript must stay quiet before Delegatus may stop its host (default `6`; `0` turns this off). Delegatus never stops a host that is mid-turn, has a pending question or holds an orchestrator seat.
- `DELEGATUS_WORKTREE_SWEEP` — `0` turns off the hourly removal of merged pipelines' worktrees; `dry-run` only reports what it would remove, in `state/worktree-sweep-report.json`.
- `DELEGATUS_WORKTREE_SWEEP_FOREIGN` — `1` lets that sweep also remove linked worktrees Delegatus did not create: ones you or another tool made with `git worktree add` in a repository Delegatus knows. Off by default: the sweep removes only checkouts that a pipeline, a workflow or a merge batch recorded creating, and reports every other one as kept with the reason `not-created-by-delegatus`. Turned on, the same guards still keep a checkout with uncommitted changes, commits that exist nowhere else, or a live process or conversation in it.
- `DELEGATUS_TEMP_SWEEP_MAX_AGE_HOURS` — age in hours at which the hourly sweep removes an unused Delegatus temp directory (`llv-*`) (default `24`; `0` turns the sweep off). It looks in `/tmp`, `/var/tmp` and the state's `scratch` directory, and never touches a pipeline worktree. The last sweep is in `state/temp-sweep-report.json`.
- `DELEGATUS_REAPER_ENABLED` — `1` lets the agent reaper stop leaked agent processes it has verified. Unset, it only lists them at `GET /api/lifecycle/reaper`.
