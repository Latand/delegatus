# Security and privacy

This page says what reaching Delegatus allows, how to keep it safe, and what
leaves your machine.

## Security

Anyone who can reach Delegatus can run commands as you, so keep it on your
own machine or behind the access key.

The server binds to `127.0.0.1` by default. Any other bind address, and
`--tailscale`, turn on the access key. Delegatus has endpoints that start
and message agents, which is why reaching it means running commands. The log
APIs refuse paths outside the known transcript folders.

Treat the tailnet URL as a secret: anyone who has it can read every
transcript and run commands through Delegatus.

A phone-access link carries the access key; [From your phone](phone.md#phone-access)
explains how it works and how `--new-token` replaces it.

## What leaves your machine

Delegatus sends an anonymous install ping to `https://delegatus.org/api/ping`
once per UTC day while the production Viewer runs, starting one minute after
boot. It is on by default. The JSON body contains exactly `id` (an independently
created random UUID stored in the state directory), `v` (version), `os`, `arch`
and `kind` (`packaged`, `checkout` or `docker`). The id is separate from the
linked-install identity. The Worker adds Cloudflare's country code and stores
these values in Analytics Engine, with no IP address. The endpoint receives the
network connection as any HTTPS service does.

Turn it off in the sidebar's ⋯ menu under **Settings → Install ping**, or start Delegatus with
`DELEGATUS_TELEMETRY=0` or `DO_NOT_TRACK=1`. Environment opt-outs always override
the switch. Tests, CI, builds, development servers and the Docker test profile
send nothing. Requests time out after five seconds and are attempted at most
once per UTC day, including after failures and restarts.

The first start shows a notice in the product and start output. The ping carries
no paths, host or user names, projects, accounts, engines or usage. Linked-install
traffic still travels directly between the peers you connect; agent providers
and explicitly configured integrations receive the requests you ask them to run.

Memory profiles send selected learned rules to Anthropic through a headless
Claude Code run (`api.anthropic.com/v1/messages`): Opus, with one Haiku fallback.
Voice-call memory sends the safe, bounded call text and any previous summary to
Haiku through the same CLI. These runs have no tools, MCP servers or custom
hooks, and do not save a CLI session. Existing profile and call-summary schema,
language, privacy and length checks still apply before storage. A separate
watchdog bounds each model invocation to 30 seconds (20 seconds for calls),
plus owned process cleanup; a Viewer restart does not remove that deadline.

For Claude limits, Delegatus runs Claude Code `/usage` in print mode with no
model turns. Claude Code handles authentication and requests Anthropic account
usage. The local reader uses its structured usage report. An unavailable or
unsupported CLI report leaves limits unknown unless the following fallback is on.

**Direct Anthropic API calls with my subscription**, under **Settings → Install
ping → What leaves my machine**, permits Delegatus itself to send an authenticated
GET to `https://api.anthropic.com/api/oauth/usage` when CLI usage is unavailable.
It carries the account's subscription OAuth token; it carries no rules, call
text or transcript. Each endpoint request has an eight-second deadline. The
switch starts off on new installations. Migration preserves on for installations
with successful direct Claude readings in the previous limits cache, including
an installation already using that path. A saved off choice always wins. A
corrupt consent file fails closed. Turning it off stops subsequent direct
requests; a request already sent can finish. Memory summaries always use Claude
Code regardless of this switch.
