import crypto from "node:crypto";
import { codexProcessCleanupConfig } from "./processCleanupPolicy";

const QUESTION_MATCHER = "request_user_input|request_user_input_async|send_user_message_async";
const QUESTION_DENIAL = "Orchestrator operator decisions require a Delegatus form. Use publish_prototype_review: 3–7 questions with a task, 1–7 without a task. Chat and reports point to the form.";

/** Codex 0.162.1 leaves async questions available when the sync setting is off.
 * Its PreToolUse boundary rejects both before execution, including control tools.
 * Compose with the existing cleanup hook so neither policy replaces the other. */
export function codexOperatorQuestionPolicy(home?: string) {
  const config = codexProcessCleanupConfig(home);
  const command = `printf '%s\\n' '${QUESTION_DENIAL.replaceAll("'", "'\\''")}' >&2; exit 2`;
  const handler = { async: false, command, timeout: 10, type: "command" };
  const group = { hooks: [handler], matcher: QUESTION_MATCHER };
  const index = config.hooks.PreToolUse.length;
  const hash = "sha256:" + crypto.createHash("sha256").update(JSON.stringify({ event_name: "pre_tool_use", ...group })).digest("hex");
  config.hooks.PreToolUse.push({ matcher: group.matcher, hooks: [{ type: "command", command, timeout: 10 }] });
  const hookState = { ...config.hooks.state,
    [`/<session-flags>/config.toml:pre_tool_use:${index}:0`]: { enabled: true, trusted_hash: hash } };
  const hooks = config.hooks.PreToolUse.map(entry => `{matcher=${JSON.stringify(entry.matcher)},hooks=[${entry.hooks.map(hook =>
    `{type="command",command=${JSON.stringify(hook.command)},timeout=${hook.timeout}}`).join(",")}]}`).join(",");
  const state = Object.entries(hookState).map(([key, value]) =>
    `${JSON.stringify(key)}={enabled=true,trusted_hash=${JSON.stringify(value.trusted_hash)}}`).join(",");
  return {
    config: { ...config, hooks: { ...config.hooks, state: hookState } },
    tools: { experimental_request_user_input: { enabled: false } },
    args: ["-c", "tools.experimental_request_user_input.enabled=false", "-c", `hooks.PreToolUse=[${hooks}]`, "-c", `hooks.state={${state}}`],
  };
}
