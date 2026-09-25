/**
 * A stand-in for `claude -p --input-format stream-json --output-format
 * stream-json --permission-prompt-tool stdio` that raises one tool permission
 * request in the middle of every turn (#2215), run as a real child process by
 * the permission tests.
 *
 * The request is the frame Claude Code sends when its safety check flags a
 * command under `bypassPermissions`, field for field as the structured host
 * recorded it: a `control_request` whose `request` is `can_use_tool` with
 * `decision_reason_type: "safetyCheck"` and `classifier_approvable: false`.
 * The CLI confirms an answer by writing the `control_response` back, which is
 * what the host waits for before it calls the request answered.
 *
 * On deny the turn carries on the way the engine does: the tool call gets an
 * error result carrying the deny message, and the model writes its next step.
 * On allow the tool "runs". Every answer received is appended as one JSON line
 * to `FAKE_CLAUDE_ANSWERS`, so a test can read exactly what the host sent.
 */
import fs from "node:fs";

export const FAKE_SAFETY_COMMAND = "rm -rf $R/home $R/*.json";
export const FAKE_SAFETY_REASON = "Dangerous rm operation on possibly-empty variable path: $R/*.json in `rm -rf $R/home $R/*.json` (rewrite it as \"${R:?}\"/*.json or use a literal path)";

function main(): void {
  const args = process.argv.slice(2);
  const sessionFlag = args.indexOf("--session-id") >= 0 ? args.indexOf("--session-id") : args.indexOf("--resume");
  const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] ?? "" : "";
  const answers = process.env.FAKE_CLAUDE_ANSWERS ?? "";
  let turn = 0;
  let initialized = false;
  const pending = new Map<string, { toolUseId: string }>();

  const emit = (value: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify({ ...value, session_id: sessionId })}\n`);
  };

  const finishTurn = (text: string): void => {
    emit({ type: "assistant", message: { role: "assistant", model: "claude-fake", content: [{ type: "text", text }] } });
    emit({ type: "result", subtype: "success", result: text });
  };

  const accept = (input: Record<string, unknown>): void => {
    if (input.type === "user") {
      turn += 1;
      if (!initialized) {
        initialized = true;
        emit({ type: "system", subtype: "init", apiKeySource: "none", model: "claude-fake" });
      }
      emit({ type: "user", isReplay: true, uuid: `user-${turn}`, message: input.message });
      const toolUseId = `toolu_fake_${turn}`;
      emit({
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-fake",
          content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: FAKE_SAFETY_COMMAND, description: "Clear the scratch tree" } }],
        },
      });
      const requestId = `request-${turn}`;
      pending.set(requestId, { toolUseId });
      emit({
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          display_name: "Bash",
          input: { command: FAKE_SAFETY_COMMAND, description: "Clear the scratch tree" },
          description: "Clear the scratch tree",
          permission_suggestions: [],
          decision_reason: FAKE_SAFETY_REASON,
          decision_reason_type: "safetyCheck",
          classifier_approvable: false,
          suppress_always_allow_rule: true,
          tool_use_id: toolUseId,
        },
      });
      return;
    }
    if (input.type === "control_response") {
      const response = (input.response ?? {}) as Record<string, unknown>;
      const requestId = typeof response.request_id === "string" ? response.request_id : "";
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      const answer = (response.response ?? {}) as Record<string, unknown>;
      if (answers) fs.appendFileSync(answers, `${JSON.stringify({ requestId, answer })}\n`);
      emit({ type: "control_response", response: { subtype: "success", request_id: requestId, response: answer } });
      if (answer.behavior === "deny") {
        emit({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: request.toolUseId, is_error: true, content: String(answer.message ?? "") }] },
        });
        finishTurn("The command needed permission, so I rewrote it with a guarded path and carried on.");
      } else {
        emit({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: request.toolUseId, content: "" }] },
        });
        finishTurn("Cleared the scratch tree.");
      }
    }
  };

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) accept(JSON.parse(line) as Record<string, unknown>);
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (import.meta.main) main();
