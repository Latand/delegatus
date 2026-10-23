# Terminal Codex MCP readiness

The terminal launch builders supply an unregistered Viewer server themselves.
A command without a launch capability uses stdio. After admission, an explicit
`LLV_MCP_TRANSPORT=http` selects HTTP when the shared endpoint's existing access
check admits it. `DELEGATUS_MCP_TRANSPORT` takes precedence. Terminal launches
keep stdio as their default; this change leaves the global transport preference
and the installer migration policy unchanged.

Codex merges configuration fields. A registered Viewer entry therefore retains
its transport. Run `scripts/install-mcp.sh` with the HTTP preference to remove
the managed registration before selecting transport per launch. The launcher
changes no account configuration. The capability is exported to the launched
process and referenced by name in the HTTP header configuration. The endpoint
continues to reject unknown and rotated capabilities in `src/lib/mcp/http.ts`.

## Reproduce and verify

The native cases in `src/lib/mcp/http.test.ts` run the real installer in an
isolated home, prove that the managed registration disappeared, and execute the
fresh and resumed terminal commands with `app-server` as the discovery
subcommand. They initialize a thread and query `mcpServerStatus/list` to require
the Viewer `list_tasks` tool. A sibling case supplies an unknown capability and
requires an empty catalog. An unrelated configured server remains disabled,
and the managed configuration must stay byte-for-byte unchanged after launch.
The fixture uses a local model catalog and sends no model request.

With a supported Codex executable on the remote runner's PATH:

```sh
gate-remote -- env LLV_NATIVE_CODEX_TEST=1 bun run test src/lib/mcp/http.test.ts
gate-remote -- bun run test src/lib/mcp/http.cancellation.test.ts
gate-remote -- bun run test src/lib/agent/cli.mcp.test.ts src/lib/agent/cli.test.ts scripts/install-mcp.test.ts
```

The runner isolates HOME, CODEX_HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR.
Set `LLV_CODEX_BINARY` to select a particular executable for discovery. The
native cases are opt-in; a run that skips them is insufficient readiness evidence.
The unit cases also cover stdio defaults, existing registrations, denied HTTP
access, invalid capabilities, publication preparation and both flag spellings.

## Before changing the terminal default

Require native discovery on each supported Codex version and platform, plus the
complete HTTP suite's migration, sibling-client and cancellation checks. Rehearse
through the stable listener with the installation's access gate enabled, then
exercise restart, capability rotation, a tool call and return to stdio. Confirm
both fresh and resumed terminal sessions keep working beside existing clients.
Record those results before changing the terminal default. This lane proves
discovery with the isolated loopback endpoint; it makes no default change and
does not claim a deployed stable-listener rehearsal.
