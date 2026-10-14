# Delegatus guide

This guide teaches the person who runs Delegatus, the operator, to install it,
give it work and steer that work. To change Delegatus itself, start at
[ARCHITECTURE.md](../../ARCHITECTURE.md) and
[CONTRIBUTING.md](../../CONTRIBUTING.md).

## Start here

Read these three pages in order the first time.

1. [Getting started](getting-started.md): install Delegatus, start it, and run
   your first agent and your first pipeline.
2. [Core concepts](concepts.md): projects, the board, the orchestrator,
   pipelines, reviews, merging, accounts and the rest, and how they fit
   together.
3. [Everyday workflows](workflows.md): asking for work, reading the board,
   answering decisions, reviewing prototypes, watching pipelines, merging,
   deploying and releasing.

## Contents

Pages marked *(planned)* are not written yet.

- [Getting started](getting-started.md): requirements, the install paths, the
  setup guide, the machine check, the first agent, preparing a project and
  the engines for pipelines, and the first pipeline.
- [Core concepts](concepts.md): one short section per idea, then how they
  connect.
- [Everyday workflows](workflows.md): the things an operator does every day.
- [A tour of the interface](interface.md): the board, **Needs you**, a card's
  ⋯ menu, the agent window, the sidebar, conversations and the composer.
- [The orchestrator in depth](orchestrator.md): creating it, the tick panel,
  rotation, the worker limit, reports and bug reports.
- [Pipelines in depth](pipelines.md): stages and roles, verdicts and fail
  edges, review rounds, merging and what happens when a pipeline ends.
- [Accounts, limits and roles](accounts-and-roles.md): accounts and usage
  windows, compatible providers, the role table, Codex CLI versions and who
  agents commit as.
- [Learned rules and shared memory](memory.md): how rules are left and
  curated, and memory shared between Claude and Codex.
- [From your phone](phone.md): the phone layout, push notifications and phone
  access.
- [Voice](voice.md): dictation, read aloud, voice conversations and Voice
  Delegatus.
- [Telegram and the chat relay](telegram.md): the bot, your own account and the
  external relay.
- [Team and linked installs](team.md): people signing in as themselves, and two
  machines sharing one board.
- [The MCP server](mcp.md): connecting your own Claude Code or Codex sessions
  to Delegatus, and the tools it offers.
- [Keeping Delegatus running and up to date](operations.md): updates,
  automatic updates, a user service, and memory and CPU limits for agents.
- [Configuration](configuration.md): the command, its options, files and
  environment variables.
- [Security and privacy](security-and-privacy.md): what reaching Delegatus
  allows and what leaves your machine.
- Where every setting lives *(planned)*: one map of every menu, switch and
  environment variable.
- Troubleshooting *(planned)*: reading a stop, a parked pipeline, a stopped
  merge, a signed-out account and other failures.

## Elsewhere in the repository

These technical documents go deeper than the guide.

- [docs/docker.md](../docker.md): the long-running Docker setup.
- [docs/macos-newcomer.md](../macos-newcomer.md): installing on macOS.
- [docs/pipelines.md](../pipelines.md): the stage contract, verdicts,
  worktrees and recovery.
- [docs/review-loop.md](../review-loop.md): how a review round runs in a
  pipeline.
- [docs/merge-batch.md](../merge-batch.md): landing several reviewed pull
  requests as one batch.
- [docs/orchestrator.md](../orchestrator.md): seat authority, mandate
  versions and rotation.
- [docs/transcription.md](../transcription.md): dictation backends.
- [docs/RELEASING.md](../RELEASING.md): how a release is cut.
- [docs/privacy-publication.md](../privacy-publication.md): the privacy check
  on everything published from this repository.

## Conventions

Bold text is a label exactly as the English interface shows it. The Ukrainian
interface (the sidebar's ⋯ menu → **Settings** → **Language**) has the same
items in the same places.

Delegatus has three ⋯ menus, and the guide names them this way:

- the sidebar's ⋯ menu, in the left sidebar: **Settings**,
  **Help and learning**, **Updates**, **Team** and **Activity**;
- the board's ⋯ menu, in a project board's header: the project's
  **Accounts**, **Merging and syncing**, **Orchestrator** and **Archive or
  delete** pages, and **Learned rules**;
- a card's ⋯, on each task card.

Where the phone layout differs, the page says so in the same paragraph. The
guide follows the `main` branch; a packaged release can lag behind it.

For maintainers: [OUTLINE.md](OUTLINE.md) is the plan for the pages still
marked planned.
