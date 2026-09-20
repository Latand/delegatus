/* Hand-assembled tool records for the phone-width row evidence (#1938).

   Every value is invented: no real path, host, secret or command from a live
   transcript appears here. The same eight cases are emitted for both engines so
   a capture shows Codex rows beside Claude rows at the same width and the two
   can be compared line for line:

     1. a clean short command,
     2. a failed command whose text is long and multi-line,
     3. a heredoc,
     4. a wrapper-prefixed command (`<tool> proxy sh -c '…'`),
     5. a command behind leading `env` assignments,
     6. a very long single-line command,
     7. an MCP call,
     8. a still-running command.

   Cases 1–6 also appear once as a grouped run that carries a failure, which is
   the shape that overlapped on the phone: a list of fixed-height rows whose
   labels wrapped out of their own boxes. A clean two-command run sits beside it
   so the phone's fold row and the desktop group header are captured too. */

export const SHORT_COMMAND = "git status --short";

export const FAILING_COMMAND = [
  "cd /workspace/demo",
  "  && bun test src/components/feed/rows.test.ts",
  "  --reporter=verbose --timeout=20000",
  "  --coverage-dir=/workspace/demo/.artifacts/coverage",
].join("\n");

export const HEREDOC_COMMAND = [
  "python3 - <<'PY'",
  "import json, pathlib",
  "rows = json.loads(pathlib.Path('rows.json').read_text())",
  "print(len([row for row in rows if row['status'] == 'failed']))",
  "PY",
].join("\n");

export const WRAPPED_COMMAND =
  "sandboxctl proxy sh -c 'cd /workspace/demo && bun run scripts/collect-rows.ts --width 390'";

export const ENV_PREFIXED_COMMAND =
  "env DEMO_CONFIG_HOME=/workspace/demo/config DEMO_STATE_DIR=/workspace/demo/state "
  + "DEMO_LOCALE=uk bun test src/components/feed/cards/toolRow.dom.test.tsx";

export const LONG_COMMAND =
  "rg --hidden --glob '!node_modules' --glob '!.git' --line-number --color never "
  + "'(tool|row|summary|chevron|duration|status)' src/components/feed src/components/mobile "
  + "| sort --field-separator=: --key=1,1 --key=2n | uniq --check-chars=200 | head --lines=40";

export const RUNNING_COMMAND = "bun run build";

export const FAILING_OUTPUT =
  "bun test v1.3.3\nsrc/components/feed/rows.test.ts:\n 12 pass\n 2 fail\n"
  + "error: expected the row box to contain its own label\n"
  + "      at src/components/feed/rows.test.ts:88:14";

export const FAILING_STDERR = "error: 2 tests failed\nexited with code 2";

const MCP_ARGUMENTS = { query: "release rows", limit: 3, format: "compact" } as const;

/* --- Claude ------------------------------------------------------------- */

const claudeUse = (id: string, name: string, input: Record<string, unknown>, ts: string) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id, name, input }] } });

const claudeResult = (id: string, text: string, ts: string, isError = false) =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] },
  });

const claudeText = (text: string, ts: string) =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "text", text }] } });

const claudeCall = (
  id: string,
  command: string,
  ts: string,
  endTs: string,
  output: string,
  isError = false,
): string[] => [claudeUse(id, "Bash", { command }, ts), claudeResult(id, output, endTs, isError)];

/** The Claude half of the comparison: the same eight cases, separated by short
    assistant lines so each one renders as its own standalone row. */
export function claudePhoneRowLines(): string[] {
  return [
    claudeText("Checking the working tree.", "2026-09-20T18:50:00Z"),
    ...claudeCall("c-short", SHORT_COMMAND, "2026-09-20T18:50:01Z", "2026-09-20T18:50:01.240Z", " M src/demo.ts"),
    claudeText("Running the row tests.", "2026-09-20T18:50:02Z"),
    ...claudeCall("c-fail", FAILING_COMMAND, "2026-09-20T18:50:03Z", "2026-09-20T18:50:05.333Z", `${FAILING_OUTPUT}\n${FAILING_STDERR}`, true),
    claudeText("Counting the failed rows.", "2026-09-20T18:50:06Z"),
    ...claudeCall("c-heredoc", HEREDOC_COMMAND, "2026-09-20T18:50:07Z", "2026-09-20T18:50:07.410Z", "2"),
    claudeText("Collecting the row geometry.", "2026-09-20T18:50:08Z"),
    ...claudeCall("c-wrapped", WRAPPED_COMMAND, "2026-09-20T18:50:09Z", "2026-09-20T18:50:10.020Z", "wrote rows.json"),
    claudeText("Re-running one file in Ukrainian.", "2026-09-20T18:50:11Z"),
    ...claudeCall("c-env", ENV_PREFIXED_COMMAND, "2026-09-20T18:50:12Z", "2026-09-20T18:50:13.700Z", "6 pass"),
    claudeText("Searching the row vocabulary.", "2026-09-20T18:50:14Z"),
    ...claudeCall("c-long", LONG_COMMAND, "2026-09-20T18:50:15Z", "2026-09-20T18:50:16.100Z", "40 matches"),
    claudeText("Looking the release up.", "2026-09-20T18:50:17Z"),
    ...[
      claudeUse("c-mcp", "mcp__catalog__lookup", MCP_ARGUMENTS, "2026-09-20T18:50:18Z"),
      claudeResult("c-mcp", "Found three releases", "2026-09-20T18:50:18.600Z"),
    ],
    claudeText("Building now.", "2026-09-20T18:50:19Z"),
    claudeUse("c-run", "Bash", { command: RUNNING_COMMAND }, "2026-09-20T18:50:20Z"),
    claudeText("A clean run of two commands folds to one line.", "2026-09-20T18:50:25Z"),
    ...claudeCall("c-c1", SHORT_COMMAND, "2026-09-20T18:50:26Z", "2026-09-20T18:50:26.200Z", " M src/demo.ts"),
    ...claudeCall("c-c2", WRAPPED_COMMAND, "2026-09-20T18:50:27Z", "2026-09-20T18:50:28.020Z", "wrote rows.json"),
    claudeText("The run above carries a failure.", "2026-09-20T18:50:30Z"),
    // One grouped run: six consecutive calls, the second of them failed.
    ...claudeCall("c-g1", SHORT_COMMAND, "2026-09-20T18:50:31Z", "2026-09-20T18:50:31.200Z", " M src/demo.ts"),
    ...claudeCall("c-g2", FAILING_COMMAND, "2026-09-20T18:50:32Z", "2026-09-20T18:50:34.333Z", `${FAILING_OUTPUT}\n${FAILING_STDERR}`, true),
    ...claudeCall("c-g3", HEREDOC_COMMAND, "2026-09-20T18:50:35Z", "2026-09-20T18:50:35.410Z", "2"),
    ...claudeCall("c-g4", WRAPPED_COMMAND, "2026-09-20T18:50:36Z", "2026-09-20T18:50:37.020Z", "wrote rows.json"),
    ...claudeCall("c-g5", ENV_PREFIXED_COMMAND, "2026-09-20T18:50:38Z", "2026-09-20T18:50:39.700Z", "6 pass"),
    ...claudeCall("c-g6", LONG_COMMAND, "2026-09-20T18:50:40Z", "2026-09-20T18:50:41.100Z", "40 matches"),
  ];
}

/* --- Codex -------------------------------------------------------------- */

const codexItem = (item: object, startedMs: number, completedMs: number, ts: string, lifecycle = "item_completed") =>
  JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type: lifecycle, turn_id: "turn-rows", item, started_at_ms: startedMs, completed_at_ms: completedMs },
  });

const codexExec = (
  id: string,
  command: string,
  startedMs: number,
  completedMs: number,
  ts: string,
  over: Record<string, unknown> = {},
): string =>
  codexItem(
    {
      type: "CommandExecution",
      id,
      command: ["sh", "-c", command],
      cwd: "/workspace/demo",
      exit_code: 0,
      status: "completed",
      stdout: "",
      ...over,
    },
    startedMs,
    completedMs,
    ts,
  );

const codexText = (id: string, text: string, ts: string) =>
  codexItem({ type: "AgentMessage", id, text }, 0, 0, ts);

/** The Codex half of the comparison: the same eight cases in the CLI's typed
    `item_completed` envelopes, separated by short agent lines. */
export function codexPhoneRowLines(): string[] {
  const t = (seconds: number) => 1789066200000 + seconds * 1000;
  const at = (seconds: number) => new Date(t(seconds)).toISOString();
  return [
    codexText("x-1", "Checking the working tree.", at(0)),
    codexExec("exec-short", SHORT_COMMAND, t(1), t(1) + 240, at(1), { stdout: " M src/demo.ts" }),
    codexText("x-2", "Running the row tests.", at(2)),
    codexExec("exec-fail", FAILING_COMMAND, t(3), t(3) + 333, at(3), {
      exit_code: 2, status: "failed", stdout: FAILING_OUTPUT, stderr: FAILING_STDERR,
    }),
    codexText("x-3", "Counting the failed rows.", at(6)),
    codexExec("exec-heredoc", HEREDOC_COMMAND, t(7), t(7) + 410, at(7), { stdout: "2" }),
    codexText("x-4", "Collecting the row geometry.", at(8)),
    codexExec("exec-wrapped", WRAPPED_COMMAND, t(9), t(9) + 1020, at(9), { stdout: "wrote rows.json" }),
    codexText("x-5", "Re-running one file in Ukrainian.", at(11)),
    codexExec("exec-env", ENV_PREFIXED_COMMAND, t(12), t(12) + 1700, at(12), { stdout: "6 pass" }),
    codexText("x-6", "Searching the row vocabulary.", at(14)),
    codexExec("exec-long", LONG_COMMAND, t(15), t(15) + 1100, at(15), { stdout: "40 matches" }),
    codexText("x-7", "Looking the release up.", at(17)),
    codexItem({
      type: "McpToolCall", id: "exec-mcp", server: "catalog", tool: "lookup",
      arguments: { clientRequestId: "request-rows", ...MCP_ARGUMENTS }, status: "completed",
      result: { content: [{ type: "text", text: "Found three releases" }] },
    }, t(18), t(18) + 600, at(18)),
    codexText("x-8", "Building now.", at(19)),
    codexItem({ type: "CommandExecution", id: "exec-run", command: ["sh", "-c", RUNNING_COMMAND], cwd: "/workspace/demo", status: "in_progress" },
      t(20), t(20), at(20), "item_started"),
    codexText("x-10", "A clean run of two commands folds to one line.", at(25)),
    codexExec("exec-c1", SHORT_COMMAND, t(26), t(26) + 200, at(26), { stdout: " M src/demo.ts" }),
    codexExec("exec-c2", WRAPPED_COMMAND, t(27), t(27) + 1020, at(27), { stdout: "wrote rows.json" }),
    codexText("x-9", "The run above carries a failure.", at(30)),
    codexExec("exec-g1", SHORT_COMMAND, t(31), t(31) + 200, at(31), { stdout: " M src/demo.ts" }),
    codexExec("exec-g2", FAILING_COMMAND, t(32), t(32) + 333, at(32), {
      exit_code: 2, status: "failed", stdout: FAILING_OUTPUT, stderr: FAILING_STDERR,
    }),
    codexExec("exec-g3", HEREDOC_COMMAND, t(35), t(35) + 410, at(35), { stdout: "2" }),
    codexExec("exec-g4", WRAPPED_COMMAND, t(36), t(36) + 1020, at(36), { stdout: "wrote rows.json" }),
    codexExec("exec-g5", ENV_PREFIXED_COMMAND, t(38), t(38) + 1700, at(38), { stdout: "6 pass" }),
    codexExec("exec-g6", LONG_COMMAND, t(40), t(40) + 1100, at(40), { stdout: "40 matches" }),
  ];
}
