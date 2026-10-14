# Accounts, limits and roles

Delegatus runs agents on your own accounts. This page covers adding accounts
and reading their limits, pointing a Claude account at a compatible provider,
the role table that decides which engine and model each job uses, the Codex
CLI versions Delegatus supports, and who agents commit as.

## Accounts and limits

Add as many Claude, Codex and Copilot accounts as you like, each with its own
login. The sidebar's system block shows each account with what is left of
its weekly limit; **All windows** lists every window: five-hour and
weekly for Claude and Codex, the monthly allowance for Copilot, each with the
share left and when it resets. Where you pick an account for a launch, each
account is a chip with its weekly percent left. **Remove** takes any account
out of Delegatus; for the engine's own default account it only forgets it,
and **Show Main again** brings it back. Switch to another account before
one runs out, or move a single agent to a different account. Agents you
start after a switch use the new active account. When a pipeline stage hits
a usage limit, Delegatus moves it to another allowed account of the same
engine; when none has room, the stage waits and carries on once an allowed
account has room or is signed in again.

![Claude accounts with their five-hour, weekly and per-model limits](../media/readme/accounts.svg)

## Compatible providers

A Claude account can also point at any service that speaks the Anthropic Messages API. Under Claude accounts, choose **Add compatible provider**. Enter its base URL, token, default model ID and optional small/fast model ID. **Load models** reads the provider's catalogue when available. For OpenCode Go, the base URL is `https://opencode.ai/zen/go`. The token stays in a private account file; provider usage limits remain unknown.

## Roles

Every job in Delegatus runs under a role: orchestrator, builder, reviewer,
verifier, architect, cleaner, prod-auditor, deployer, merger, visual critic
and others. The role registry decides which engine, model, effort and access
each one uses, and a stage may override any of them. Read and change the table
under **Roles: engine and model** in **Settings** (sidebar's ⋯ menu). The
orchestrator seat and your own session read the same table, and change it,
through the MCP tool `role_presets` (see [The MCP server](mcp.md#the-tools));
a model outside the launch catalogue is refused, and every write is logged to
`role-presets-audit.jsonl` beside `role-presets.json`. The defaults live in
`src/lib/roles/defaults.ts`.

A stage whose role names an engine that is not connected is refused before
any stage starts; [Getting started](getting-started.md#if-only-one-engine-is-connected)
shows how to move the roles to the engine you have.

## Codex CLI versions

Hosted Codex sessions and account operations support CLI 0.154.0, 0.159.0
and 0.162.1. An unpinned version is refused before its app-server starts;
the error names the supported versions and regeneration script. See the
[protocol boundary](../design/codex-pinned-protocol.md) for compatibility
checks and the approval router's remaining replay work.

## Who agents commit as

Agents commit with the Delegatus machine identity, so a personal Git
identity stays out of their commits. For a repository listed in
`forge-app-repositories.json` in the state directory, their pushes, pull
requests and merges go out as the Delegatus GitHub App.
