# Accounts, limits and roles

Delegatus runs agents on your own accounts. This page covers adding accounts
and reading their limits, pointing a Claude account at a compatible provider,
the role table that decides which engine and model each job uses, the Codex
CLI versions Delegatus supports, and who agents commit as.

## Accounts and limits

Add as many Claude, Codex and Copilot accounts as you like, each with its own
login.

- **Where you see limits.** The sidebar's system block shows each account
  with what is left of its weekly limit. **All windows** lists every window:
  five-hour and weekly for Claude and Codex, the monthly allowance for
  Copilot, each with the share left and when it resets. Where you pick an
  account for a launch, each account is a chip with its weekly percent left.
- **Remove and Show Main again.** **Remove** takes any account out of
  Delegatus. For the engine's own default account it only forgets it, and
  **Show Main again** brings it back.
- **Automatic selection.** Unpinned work ranks the project's allowed accounts;
  an unbound project allows all listed accounts. Among fresh balances above
  25% remaining in every governing window, the account whose binding window
  resets soonest goes first. The binding window has the least headroom across
  session, week and the requested Claude model's tier; tied binding windows
  use the latest reset. If any adequately provisioned candidate's binding reset
  is missing or has passed, that group uses most headroom instead. Equal resets
  use most headroom, then the supplied account preference, then account ID.
  Smaller balances remain fallbacks in headroom order. On retries, untried
  accounts retain priority. A named account keeps its identity.
- **Switching.** Switch the active account to change the routing preference,
  or move a single agent to another account. Choose an account explicitly when
  you want a launch to use it.
- **Claude readings.** The existing Claude Code `/usage` command supplies fresh
  session, weekly and per-model reset windows, shared by the accounts panel,
  footer and `account_limits`. It runs no model turn. Direct subscription API
  fallback still requires the installation's existing consent. A failed refresh
  keeps the last reading and its original time, marked stale.
- **At a limit.** When a pipeline stage hits a usage limit, Delegatus moves it
  to another allowed account of the same engine. When none has room, the
  stage waits and carries on once an allowed account has room or is signed in
  again.
- **Paid Codex credits.** Accounts reporting a paid balance stop accepting turns
  at 99% usage by default. The pipeline controller stops a running stage on a
  guarded account or one removed from the project's binding. It keeps the
  checkout and resumes the work in a linked successor attempt on an allowed
  account. With no available account, the host stays stopped while the
  controller checks for capacity. The percentage is [configurable](configuration.md#environment-variables).
  Protection uses the provider's observed usage; quota reads run periodically.
- **Retry after a limit or removal.** Retry-stage can accept an attempt whose
  account is exhausted or no longer allowed, even while the old turn or a
  delivery is still pending. Replacement waits for confirmed termination and
  delivery settlement. A stop that cannot be confirmed remains visible and
  is retried using its original operation key.

![Claude accounts with their five-hour, weekly and per-model limits](../media/readme/accounts.svg)

## Compatible providers

A Claude account can also point at any service that speaks the Anthropic
Messages API.

1. Under Claude accounts, choose **Add compatible provider**.
2. Enter its base URL, token, default model ID and optional small/fast model
   ID. **Load models** reads the provider's catalogue when available.

For OpenCode Go, the base URL is `https://opencode.ai/zen/go`. The token stays
in a private account file; provider usage limits remain unknown.

## Roles

Every job in Delegatus runs under a role: orchestrator, builder, reviewer,
verifier, architect, cleaner, prod-auditor, deployer, merger, visual critic
and others. The role registry decides which engine, model, effort and access
each one uses, and a stage may override any of them. Read and change the table
under **Roles: engine and model** in **Settings** (sidebar's ⋯ menu). The
orchestrator seat and your own session read the same table, and can change
it from a session.

A stage whose role names an engine that is not connected is refused before
any stage starts; [Getting started](getting-started.md#if-only-one-engine-is-connected)
shows how to move the roles to the engine you have.

## Codex CLI versions

Delegatus supports Codex CLI 0.154.0, 0.159.0 and 0.162.1. With any other
version, a Codex session does not start and the error lists the supported
versions. See the [protocol boundary](../design/codex-pinned-protocol.md).

## Who agents commit as

Agents commit with the Delegatus machine identity, so a personal Git
identity stays out of their commits. For a repository listed in
`forge-app-repositories.json` in the state directory, their pushes, pull
requests and merges go out as the Delegatus GitHub App.
