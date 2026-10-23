# Agent MCP access with an installation key

Enabling phone access configures the installation access key. Previously,
`viewerMcpTransportForLaunch` switched agents to stdio unless a trusted local
gateway supplied authentication. An ordinary package installation therefore
lost the shared HTTP MCP transport when the key was enabled.

`src/lib/mcp/httpAccess.ts` derives a separate credential using HMAC-SHA256,
the installation key and a versioned MCP purpose. The Viewer places this
credential in the generated MCP server definition. The installation key stays
out of agent environments, command arguments and generated HTTP definitions.
The credential remains valid across Viewer process restarts; rotating the
installation key revokes it. There is no credential cache or extra durable key.

`src/proxy.ts` accepts the credential only for POST to the MCP endpoint, with a
loopback Host, a local or absent Origin, and no remote forwarding address.
The global Host allowlist runs first. Other paths and remote callers retain
the existing access-key, cookie and team rules. MCP access supplies no operator
identity: the team gate and MCP handler still verify the launch capability,
and every tool keeps its own authorization policy. A credential alone cannot
call tools. Authentication failure never returns a credential or sets a cookie.

Claude and Copilot receive the credential in their private generated config
files. Structured Codex receives it through its thread configuration. Terminal
Codex keeps HTTP opt-in and references the credential by environment name. Its
launch command reads an owner-only file, scoped to the account and endpoint;
the file is atomically replaced on key rotation. Neither the key nor the MCP
credential appears in the command. The account configuration stays unchanged.
Existing Codex stdio registrations retain their transport. An HTTP override pointing at
another local service receives no credential and retains the stdio fallback.

The request path adds a bounded HMAC and header checks. No performance gain is
claimed.

## Verification

Run each test file in a fresh isolated process, with private HOME,
XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, through the remote gate:

```sh
gate-remote -- bun run test src/lib/mcp/httpAccess.test.ts
gate-remote -- bun run test src/lib/mcp/http.test.ts
gate-remote -- bun run test src/proxy.test.ts
gate-remote -- bun run test src/proxy.host.test.ts
gate-remote -- bun run test src/proxy.team.test.ts
gate-remote -- bun run test src/lib/agent/spawnPolicy.test.ts
gate-remote -- bun run test src/lib/agent/cli.mcp.test.ts
gate-remote -- bun run test src/lib/codexHeadlessConfig.test.ts
gate-remote -- bun run test src/lib/runtime/copilotAcpHost.test.ts
```

The HTTP regression spawns a separate SDK client from the actual generated
Claude definition, then calls a production Delegatus tool through the proxy and
exported route, using the real registry and tool service. It covers key on and
key off. Negative cases cover foreign Hosts and Origins, remote forwarding,
unrelated routes and methods, malformed native proofs, missing and rotated
capabilities, and key rotation. Separate processes verify that a Viewer restart
does not lose the credential. Team cases verify that the credential cannot
bypass member or agent identity checks.
The native terminal cases in the HTTP suite also cover keyed discovery when
`LLV_NATIVE_CODEX_TEST=1` is set, using Codex itself without a model request.
