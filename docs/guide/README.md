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
  setup guide, the machine check, the first agent and the first pipeline.
- [Core concepts](concepts.md): one short section per idea, then how they
  connect.
- [Everyday workflows](workflows.md): the things an operator does every day.
- The orchestrator in depth *(planned)*: the tick panel, board maintenance,
  rotation, the report log and bug reports.
- Pipelines in depth *(planned)*: the stage graph, fail edges and their
  budgets, switching a running stage, retry, skip and close, recovery and
  the merger batch.
- Accounts, limits and roles *(planned)*: adding accounts and compatible
  providers, usage windows, project account bindings and the role table.
- Memory: learned rules and shared memory *(planned)*: how rules are written
  and curated, and memory shared between Claude and Codex.
- From your phone *(planned)*: phone access, the phone layout and push
  notifications.
- Voice *(planned)*: dictation, read aloud, voice conversations and Voice
  Delegatus.
- Keeping Delegatus running and up to date *(planned)*: updates, running as a
  user service, and the Docker production instance.
- Where every setting lives *(planned)*: one map of every menu, switch and
  environment variable.
- Troubleshooting *(planned)*: reading a stop, a parked pipeline, a stopped
  merge, a signed-out account and other failures.

## Elsewhere in the repository

These already teach their subject, so the guide links to them.

- [Read any agent as a chat](../../README.md#read-any-agent-as-a-chat): every
  agent conversation on your machine as a chat, with search.
- [Telegram](../../README.md#telegram): the bot, the chats agents may post to,
  and the read-only server for your own account.
- [Team](../../README.md#team): people signing in as themselves.
- [Linked installs](../../README.md#linked-installs): two machines sharing
  one board.
- [External relay](../../README.md#external-relay): answering a relay
  service's chats from this install.
- [MCP server for agents](../../README.md#mcp-server-for-agents): connecting
  your own Claude Code or Codex sessions to Delegatus.
- [Configuration](../../README.md#configuration): the command, its options,
  files and environment variables.
- [Platform support](../../README.md#platform-support) and
  [Security](../../README.md#security).
- [What leaves your machine](../../README.md#what-leaves-your-machine).
- [docs/docker.md](../docker.md): the long-running Docker setup.
- [docs/macos-newcomer.md](../macos-newcomer.md): installing on macOS.
- [docs/pipelines.md](../pipelines.md): the stage contract, verdicts,
  worktrees and recovery.
- [docs/merge-batch.md](../merge-batch.md): landing several reviewed pull
  requests as one batch.
- [docs/orchestrator.md](../orchestrator.md): rotating the orchestrator.
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
