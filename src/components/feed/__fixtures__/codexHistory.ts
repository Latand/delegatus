/** Invented Codex records. Sizes and shapes exercise history paging without
 * carrying any transcript text, personal identifiers or machine paths. */
export const historyAt = (n: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, n)).toISOString();
export const historyRecord = (type: string, payload: object, n = 0) => JSON.stringify({ type, timestamp: historyAt(n), payload });
export const historyCall = (id: string, n = 0, cwd = "workspace") => historyRecord("response_item", {
  type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: "echo fixture", cwd }),
}, n);
export const historyOutput = (id: string, n = 1, text = "fixture output") => historyRecord("response_item", { type: "function_call_output", call_id: id, output: text }, n);
export const historyUsage = (n: number, total = n * 100, prompt = total) => historyRecord("event_msg", {
  type: "token_count", info: { last_token_usage: { input_tokens: prompt, output_tokens: 10 }, total_token_usage: { total_tokens: total } },
}, n);

export function codexHistoryCorpus(length: number, resultChars = 1400): string[] {
  const lines: string[] = [historyRecord("session_meta", { cwd: "workspace", model: "fixture-model" })];
  let turn = 0;
  while (lines.length < length) {
    const id = `call-${turn}`;
    const n = turn * 10;
    lines.push(
      historyRecord("turn_context", { cwd: "workspace", turn_id: `turn-${turn}` }, n),
      historyRecord("event_msg", { type: "task_started", turn_id: `turn-${turn}` }, n),
      historyRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `Inspect fixture ${turn}` }] }, n),
      historyCall(id, n + 1),
      historyOutput(id, n + 2, "fixture result line\n".repeat(Math.ceil(resultChars / 20)).slice(0, resultChars)),
      historyUsage(n + 3, (turn + 1) * 1000, (turn + 1) * 900),
      historyRecord("event_msg", { type: "agent_message", message: `Fixture ${turn} checked` }, n + 4),
      historyRecord("event_msg", { type: "task_complete" }, n + 5),
    );
    turn += 1;
  }
  return lines.slice(0, length);
}

export function codexHistorySeams(): string[] {
  const structured = "<!-- llv:structured-user ctx=o." + "A".repeat(43) + "." + "b".repeat(16) + " -->\nInspect the fixture";
  return [
    historyRecord("turn_context", { cwd: "workspace", turn_id: "turn-a" }),
    historyRecord("event_msg", { type: "task_started" }),
    historyRecord("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: structured }] }),
    historyCall("early", 1),
    historyRecord("response_item", { type: "custom_tool_call", name: "exec", call_id: "wrapper", input: 'text(await tools.exec_command({cmd:"echo nested"}));' }, 2),
    historyRecord("event_msg", { type: "item_completed", item: { type: "commandExecution", id: "exec-child", command: "echo nested", status: "completed", aggregatedOutput: "nested" } }, 3),
    historyOutput("wrapper", 4, "Script completed\nOutput:\nnested"),
    historyRecord("event_msg", { type: "user_message", message: "Inspect the fixture" }, 0),
    historyOutput("early", 5, "Process running with session ID 71\nOutput:\nfirst"),
    historyUsage(6, 1000, 100),
    historyRecord("turn_context", { cwd: "other-workspace", turn_id: "turn-b" }, 7),
    historyCall("later", 8),
    historyOutput("later", 9, "second\n[stderr]\nwarning"),
    historyUsage(10, 2000, 1000),
    historyRecord("event_msg", { type: "agent_message", message: "Fixture checked" }, 11),
    historyRecord("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixture checked" }] }, 11),
    historyRecord("event_msg", { type: "task_complete" }, 12),
  ];
}
