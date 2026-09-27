# Viewer MCP continuity across releases

The installed `bin/mcp-server.mjs` owns an agent's stdio pipe for the life of
the agent session. It selects the currently published MCP runtime for each
request. When the release identity changes, it starts that release's bundle and
replays MCP initialization into the child. A child exit starts bounded retries:
200 ms, doubling to a 5-second ceiling. While the child is absent, `tools/list`
uses the last successful list and `tools/call` returns an MCP tool result with
`isError: true` and a retry instruction. The agent's MCP connection stays open.

For stdio seats with a launch capability, the launcher refreshes a private
record under `state/mcp-runtime/sessions/` every 30 seconds. The filename is
the SHA-256 digest of the capability; the record contains no credential. After
a 10-minute startup grace, the seat tick declares the MCP unavailable when
that record is missing, older than two minutes, or reports a disconnected
child for over two minutes. It puts a rotation request on the board and
withholds wakes from that seat. A fresh, ready record clears the card. HTTP MCP
sessions use the shared Viewer endpoint and have no per-session launcher, so
this rule does not classify them.

The service token remains a read-only fallback in team mode. It does not
authorize `POST /api/conversation-host`: that write must carry an agent's
verified spawn capability, an authenticated member session, or a verified
internal service claim. A seat should use its MCP tools after reconnection;
an operator can rotate a seat whose MCP process has died.
