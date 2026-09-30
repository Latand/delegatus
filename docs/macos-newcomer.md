# A newcomer on macOS

## Observation, 2026-09-30

At the task's main snapshot, both `landing/site/copy.js` prompts installed Bun
and `delegatus-cli`, started it with `--no-open`, waited for the site and then
ran `claude mcp add` or `codex mcp add`. Neither checked or installed the agent
CLI. They used `bun` and `delegatus-mcp` by name after installing Bun without
adding its bin directory to PATH. A desktop agent session can therefore reach
MCP registration with its matching terminal command missing.

The launcher printed the URL and log locations, without checking for either
agent CLI. The setup guide already showed a missing-CLI state and install
commands, disabled account actions until the CLI was found, and offered
**Check again** (`EnginesStep.tsx`, `GET /api/accounts/cli`). Its presence probe
runs only `--version`; presence does not prove that an account is signed in.

The shared agent resolver searched user bin directories, `/usr/local/bin` and
`/usr/bin`, then returned the bare command. It omitted the Codex desktop bundle
and Homebrew's Apple Silicon prefix. Both package entrypoints also required
`node` in their shebang. A launcher regression with only Bun on PATH reproduced
`env: node: No such file or directory` before the shebang fix.

Verified upstream facts:

- [Claude desktop quickstart](https://code.claude.com/docs/en/desktop-quickstart)
  says to install the terminal CLI separately. The app includes its Code tab;
  that does not establish an externally supported `claude` executable.
  [Claude setup](https://code.claude.com/docs/en/setup) documents the separate
  native launcher's `~/.local/bin/claude` location. Delegatus already probed it.
- [OpenAI troubleshooting](https://learn.chatgpt.com/docs/reference/troubleshooting)
  documents `/Applications/Codex.app/Contents/Resources/codex --version` for
  the bundled executable. Delegatus now tries this after normal CLI locations,
  plus the equivalent bundle under `~/Applications`. The user-app location is
  a conventional macOS install layout covered by a fixture, not an upstream
  promise. [Codex CLI docs](https://developers.openai.com/codex/cli) also
  describe a separate terminal installation and sign-in.
  The installed npm Codex entrypoint inspected locally uses a Node shebang.
  The updated prompt and startup message use the documented native Codex
  installer so a Mac with only Bun can follow the advice.

No live logged-in Mac or desktop installer was available in this investigation.
These documentation checks establish the supported Claude installation and the
documented Codex executable path. The rehearsal tests a bundle-layout stub;
it does not establish that every desktop release or renamed app bundle exposes
that executable, or that desktop credentials transfer to Delegatus accounts.
The updated prompts register MCP with absolute Bun and entrypoint paths so a
new desktop session can start it even when the app's PATH predates Bun's install.

## Automated rehearsal

`.github/workflows/macos-newcomer.yml` runs manually, for relevant pull requests
and on `v*` release tags. A branch/PR packs its exact checkout with `npm pack`;
a tag waits, bounded, for its exact package version on npm and installs that.
The build uses runner tools. The visitor rehearsal then starts with a separate
empty home, config, state and PATH, installs Bun through the site's command and
installs the selected package with the prompt's global-install command.

`scripts/newcomer-install.mjs` reads both shipped prompts. It verifies the
launcher and setup API with neither CLI present, each engine separately on
PATH, and a Codex stub under the user desktop bundle path. Stub commands allow
only `--version` and MCP registration; the report refuses any other call.
It never signs in or creates an orchestrator. The driver tracks each launcher
it starts and shuts it down through its own child handle.

Node supervises the driver while the installed package runs on the visitor's
new Bun. The driver substitutes an ephemeral port for 8898 and a tracked background
process for `nohup`. It deliberately leaves out downloading real agent CLIs:
the missing case is the regression, and the stubs exercise discovery and MCP
registration without authentication. The report artifact records each case,
the API response, the first-start message and the bounded startup logs. The
job has a 35-minute limit; each first start has a 60-second limit.

Run after packing on a Mac:

```sh
node scripts/newcomer-install.mjs /path/to/delegatus-cli.tgz /path/to/report
```

## Five-minute manual checklist

Use a fresh macOS user with a desktop app already installed and signed in.
Prepare the app and account before starting the five-minute check. Repeat for
Claude and Codex; do not remove another user's CLIs or credentials.

1. **Minute 0–1:** In Terminal run `command -v claude` and `command -v codex`.
   Record the app version and whether each command exists. For Codex also run
   `/Applications/Codex.app/Contents/Resources/codex --version` (or its
   `~/Applications` counterpart). An absent bundle executable should lead to
   the separate CLI install step. For Claude expect a separate CLI installation.
2. **Minute 1–3:** Open the app's local coding session on a disposable project.
   Copy the matching prompt from the landing page and ask the agent to run it.
   Check that it verifies/installs the matching CLI before starting Delegatus,
   reports any install error, registers MCP and returns a working local URL.
   A plain desktop chat without local shell access must explain that limitation.
3. **Minute 3–4:** Open the URL. Check the engine's state and complete its
   account sign-in if requested. A desktop login alone must not be presented as
   a connected Delegatus account. If the CLI was just installed, use **Check
   again**, or restart Delegatus as the terminal message asks.
4. **Minute 4–5:** Start a new coding session and confirm that the `viewer` MCP
   tools are available. Record pass/fail, any app permission prompt and the
   first failing step. If downloads or sign-in exceed the timebox, record
   **pending**, together with the step, rather than claiming success.

Keep account identifiers and credentials out of shared evidence. Stop only
the Delegatus process started for this check. Site publication belongs to the
orchestrator; this workflow never publishes it.
