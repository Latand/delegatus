# Getting started

This page takes you from nothing to an orchestrator working on your project,
and then to a first pipeline that ends in a pull request. Terms in it are
explained in [Core concepts](concepts.md).

## What you need

Delegatus runs on your own machine and drives the agent command-line tools
you already use.

- Bun 1.4 or newer. On Linux the installer needs `unzip`; install it with
  your package manager first if it is missing. Then install Bun:

  ```bash
  curl -fsSL https://bun.com/install | bash
  ```

  The installer adds Bun to your shell's startup file, which only new
  terminals read. Open a new terminal, or make it available in this one:

  ```bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
  bun --version
  ```

  `bun --version` must print 1.4 or newer before you go on. `~/.local/bin`
  is where the Claude Code installer puts `claude`. Bun's
  [installation page](https://bun.com/docs/installation) covers other
  systems and problems.
- Claude Code or Codex. The orchestrator runs on one of them, so install
  at least one:
  - Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
  - Codex: `curl -fsSL https://chatgpt.com/codex/install.sh | sh`

  GitHub Copilot is optional: `bun add -g @github/copilot`. It runs single
  agents only and cannot run the orchestrator. When Delegatus reports Copilot
  missing, its message names the exact package version to install.
- git, and a project that is a git repository with at least one commit. A
  pipeline works in a git worktree of your project and starts from a commit.
  By default that commit is the tip of `main` on the project's `origin`
  remote, which the pipeline fetches first, so the project also needs an
  `origin` with a `main` branch. [Prepare a project for
  pipelines](#prepare-a-project-for-pipelines) shows both setups.
- For pull requests and merging: the same `origin` on GitHub, and the GitHub
  CLI (`gh`) signed in. Without a GitHub pull request, pipelines end without
  a merge, and a stopped merge names a signed-out `gh` as its reason.
- Linux or macOS. Linux is the main platform and macOS works. Native
  Windows runs Delegatus with Claude Code only; use WSL 2 for Codex, the MCP
  server and the rest. [Platform support](../../README.md#platform-support)
  has the details.

## Choose how to install

There are five ways to get Delegatus. Most people start with the first or
the second.

| Path | When it fits | Command | A `delegatus` command stays installed | How it updates |
| --- | --- | --- | --- | --- |
| Run the package | Trying it out | `bunx delegatus-cli` | No | The **Update** dialog, or `bunx delegatus-cli@latest` |
| Keep a command installed | Daily use | `bun add -g delegatus-cli` | Yes | The **Update** dialog, or `bunx delegatus-cli@latest` |
| Let your coding agent install it | You already work in Claude Code or Codex | The install prompt on the Delegatus website | Yes | As above |
| Run from a clone | Reading or changing the source | `git clone`, then `bun install`, `bun run build`, `bun bin/cli.mjs` | No | The **Update** dialog, or pull and build again |
| Docker | A long-running server, or a look at the interface | See below | No | `scripts/rebuild.sh` on the production setup |

### Run the package

```bash
bunx delegatus-cli
```

This downloads and runs the published package without installing a command.

### Keep a command installed

```bash
bun add -g delegatus-cli
```

This installs three commands into `~/.bun/bin`: `delegatus`, its short alias
`dlg`, and `delegatus-mcp`, the MCP server agents use to reach Delegatus.
`bun add -g` needs no root. Start Delegatus with `delegatus`; `delegatus
--help` lists its options.

### Let your coding agent install it

The Delegatus website, [delegatus.org](https://delegatus.org), has an install
prompt for Claude Code and one for Codex. Paste it into a session of that
agent and it does the following, in order:

1. checks for Bun 1.4 or newer and installs it if needed;
2. checks for the agent's own CLI and installs it if it is missing;
3. installs the package with `bun add -g delegatus-cli`;
4. starts Delegatus in the background with `--no-open`, so it keeps running
   after that session, and waits for `http://127.0.0.1:8898/` to answer;
5. registers the MCP server for that agent under the name `viewer`, which
   takes effect in the agent's next session;
6. gives you the link to open.

On native Windows it stops after the first step and asks you to run it inside
WSL 2. On macOS the Claude desktop app needs the separate Claude Code CLI,
and the Codex app may carry a CLI of its own;
[docs/macos-newcomer.md](../macos-newcomer.md) explains what the prompt
checks there.

### Run from a clone

Get the source first. Its address is the **GitHub** link at the top of
[delegatus.org](https://delegatus.org). Clone it and enter the checkout; every
command below runs from there:

```bash
git clone <repository URL> delegatus
cd delegatus
bun install
bun run build
bun bin/cli.mjs
```

The command serves the output of the last build, so build again after every
pull. `bun dev` runs the app with hot reload, and with it you start the
runtime host yourself. [From a clone](../../README.md#from-a-clone) in the
README has the rest.

### Docker

You do not need Docker for agents or pipelines: the packaged command already
starts and supervises its own runtime host. Docker has two setups, and both
run from a clone of the source (see [Run from a clone](#run-from-a-clone) for
getting one), because `docker-compose.yml` is at the top of that checkout.

- **The test Viewer** shows the interface over your existing transcripts and
  nothing more. It is the web app alone, without a runtime host, so it
  cannot start an orchestrator, an agent or a pipeline. The README's
  [Docker](../../README.md#docker) section has its two commands. It opens
  on `http://127.0.0.1:8901/`, runs in the background, and stops with
  `docker compose --profile test stop viewer-test`.
- **The production setup** is the Docker installation that runs agents. Its
  runtime host owns `http://127.0.0.1:8898/` and starts the web app as a
  release it can replace. Follow [Production
  instance](../docker.md#production-instance) in docs/docker.md from top to
  bottom: pull the images, keep a first Viewer on port 8898 while the
  bootstrap builds the first managed release, then start the runtime host
  and check that port 8898 answers. Agents started there run the `claude`,
  `codex` and `bun` installed on the host, so install them on the host first.
  `docker compose --profile runtime-host stop runtime-host` stops the
  runtime host and with it the listener on port 8898.

After the production setup answers on port 8898, continue at [The setup
guide](#the-setup-guide).

## Start Delegatus

This section is for the package, the installed command and the clone. A
Docker production setup is already running once its runtime host answers.

Run the command for your install path. Delegatus listens on
`http://127.0.0.1:8898/` and opens it in your browser when it can.

- `--port <n>` (or `-p <n>`) picks another port. If the port is busy, the
  start output says so and suggests the next one, for example
  `bunx delegatus-cli --port 8899`.
- `--no-open` leaves the browser closed; open the address yourself.
- If neither Claude Code nor Codex is found, the start output prints both
  install commands above. Install one, restart Delegatus and open the setup
  guide.

The command starts two processes: the web app, and the runtime host that
launches and supervises agents. Ctrl+C stops both.

Delegatus reads the transcripts already on your machine, from
`~/.claude/projects`, `~/.codex/sessions` and `~/.copilot/session-state`, so
your earlier agent sessions appear as chats straight away.

The first start shows a notice about the anonymous install ping, in the page
and in the start output. Turn it off in the sidebar's ⋯ menu under
**Settings** → **Install ping**, or start Delegatus with
`DELEGATUS_TELEMETRY=0` or `DO_NOT_TRACK=1`.
[What leaves your machine](../../README.md#what-leaves-your-machine) lists
what it sends.

## The setup guide

On a new install, the page opens the setup guide, titled **Set up
Delegatus**. Its numbered steps are **Engines**, **Project**, **Telegram
(optional)** and **Orchestrator**, and they end on a running orchestrator.

1. **Engines** shows Claude Code, Codex and GitHub Copilot, each as
   **Connected**, **Installed, signed out** or **Not installed**. Sign in to
   the ones you use. After installing a missing CLI, press **Check again**.
   If you use a service that speaks the Anthropic Messages API, **Add
   compatible provider** under Claude accounts takes its address, token and
   models; the README's [Quick start](../../README.md#quick-start) has the
   fields.
2. **Project** asks for the folder the orchestrator will work on. Pick it from
   **Already on this computer**, which lists the projects Delegatus already
   found here with how many conversations each has, or **Open another
   folder**.
3. **Telegram (optional)** sends the orchestrator's reports to one Telegram
   chat as well as to its report log. Skip it if you do not use Telegram.
4. **Orchestrator** shows the draft it will create: the engine, model, effort
   and account it will run on, each of which you can change. **Read its
   instructions first** shows its prewritten standing instructions, which you
   can edit. **Create the orchestrator** starts it.

An **Interface walk** of three stops follows: the orchestrator's chat, the
board, and **Needs you**.

Under **Later, any time** the guide keeps five more steps that are never in
the way of a first orchestrator: **Agents** (which engine, model and effort
each role runs on), **Phone**, **Voice**, **Check** and **Relay service**.

Reopen the guide any time from the sidebar's ⋯ menu → **Help and learning**
→ **Setup guide**. **Interface walk** sits beside it.

## Check that this machine works

This step is optional. Open the setup guide's **Check** step and press **Run
the check**. It runs one tiny pipeline in a scratch folder and then wakes a
test orchestrator. It takes about two minutes, has a five-minute limit and
touches none of your projects.

It reports five rows:

- An agent starts
- A message reaches it
- The stage reports back
- The orchestrator is woken
- Your orchestrators are filed under the right project

When a row fails, the check stops there and says what to fix; the rows before
it passed. Fix that and run it again.

## Your first agent

Your first agent is the orchestrator you just created. Write to it in its
chat the way you would message a colleague, for example "add a delete command
to todo.py". It answers in the same chat, and its work shows up on the
board.

You can also start a single agent without the orchestrator. Press **+** in
the board's header and choose **New conversation with an agent**. The form is
the composer itself: pick the engine, model and reasoning in its runtime
pill, type or dictate your request, and send. The pane then becomes the
conversation. Copilot agents start only this way.

## Prepare a project for pipelines

A pipeline starts from a commit of your project, so the folder needs one
before the first pipeline. Git also needs to know who you are before it
commits, and a new machine often has no identity set. `git config user.name`
and `git config user.email` each print a value when it is. When either prints nothing, `git commit` stops
with `Author identity unknown`. Set both once for every repository on the
machine, with your own name and an address you are happy to see in public
history (GitHub offers a no-reply address under **Settings** → **Emails**):

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

To set an identity for this project only, leave out `--global`.

Pick one of these:

- **A repository on GitHub.** This is the default and the only setup that
  ends in a pull request. The project needs at least one commit and an
  `origin` remote whose `main` branch holds it. For a new folder:

  ```bash
  git init -b main
  git add -A
  git commit -m "Initial commit"
  gh repo create --private --source . --push
  ```

  `git remote -v` then shows `origin`, and `git ls-remote origin main`
  prints a commit. If your project's main branch has another name, tell the
  orchestrator that name when you ask for work.
- **A local repository with no remote.** Commit your work as above, without
  the last line. When you ask for work, tell the orchestrator to pin the
  pipeline's base to your current commit, which `git rev-parse HEAD` prints.
  A pipeline pinned that way never fetches from a remote. It ends with its
  work on its own branch, without a pull request.

`git init` on its own is not enough: it creates neither a commit nor an
`origin`. A pipeline in such a folder parks before its first stage, and its
reason names the `origin/main` it could not fetch.

## If only one engine is connected

Each pipeline stage runs on the engine its role is mapped to. The general
**Builder** and the **Reviewer** both default to Codex, so an installation
with only Codex connected can run a build-and-review pipeline made of those
two roles. Some Builder variants default to Claude Code instead: the
documentation, frontend and trivial-size rows, and the fix rounds for
documentation and frontend work. A pipeline that selects one of those, or a
setup with only Claude Code connected, meets a stage whose engine is not
connected. That pipeline is refused before any stage starts, with a message
that a stage's engine is not connected. Before the first pipeline, do one of
these:

- connect the other engine in the setup guide's **Engines** step;
- open the sidebar's ⋯ menu → **Settings** → **Roles: engine and model**
  and move every role you will use to the engine you have. When roles sit on
  an engine that is not connected, the table says so above its rows and
  offers a button that moves them to the connected one. A change applies to
  pipelines created after it;
- or ask the orchestrator to set the engine on each stage of that one
  pipeline.

## Your first pipeline

Ask the orchestrator for one small, well-defined change, such as a single bug
fix or a small feature in one file. Then watch it appear:

1. A task card appears on the board.
2. A pipeline row appears on the card, with its stages as a chain: typically
   a builder, a reviewer and sometimes a verifier.
3. Each stage is an agent with its own conversation. Open the row to see the
   stage graph beside the conversations.
4. The reviewer reads the builder's change. If it finds problems, the builder
   fixes them and a fresh reviewer looks again, up to the pipeline's review
   budget.
5. The pipeline ends with a pull request open on GitHub, and the orchestrator
   files a report in the **Reports** log beside its chat.

If the pipeline needs you, **Needs you** counts it and the card's state line
says why. A question for you waits in the **Decisions** tab beside the
orchestrator's chat.

Merging is off by default, so you merge the pull request yourself, on GitHub
or by asking the orchestrator. To have Delegatus merge what passes review,
turn on **Merge when the review passes**; see
[Merge and deploy](workflows.md#merge-and-deploy).

## If something does not start

- No agent CLI found. The start output prints the install commands for
  Claude Code and Codex. Install one, restart Delegatus, and press **Check
  again** in the setup guide's **Engines** step.
- An account is signed out. The **Engines** step shows **Installed, signed
  out**. Sign in there; the orchestrator draft also asks you to sign in
  before it can start.
- The port is busy. The start output suggests the next port; start again
  with `--port` and that number.
- Only Copilot is installed. Copilot cannot run the orchestrator. Install
  Claude Code or Codex as well.
- "not a git repository", or the pipeline stops while resolving its base.
  The pipeline needs a commit to start from. Follow [Prepare a project for
  pipelines](#prepare-a-project-for-pipelines).
- The pipeline is refused because an engine is not connected. See [If only
  one engine is connected](#if-only-one-engine-is-connected).
- No pull request, or no merge. Pull requests and merging need a GitHub
  `origin` and a signed-in `gh`. Run `gh auth login` and check
  `git remote -v`.

[Configuration](../../README.md#configuration) in the README lists every
option and environment variable.

## Next

- [Core concepts](concepts.md): what each part is and how they connect.
- [Everyday workflows](workflows.md): asking for work and steering it.
- [Phone access](../../README.md#phone-access): opening Delegatus on your
  phone.
- [MCP server for agents](../../README.md#mcp-server-for-agents): giving your
  own Claude Code or Codex sessions the same tools the orchestrator uses.
