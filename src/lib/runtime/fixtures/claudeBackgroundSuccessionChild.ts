import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const root = process.argv[2]!;
const sessionId = process.argv[3]!;
const mode = process.argv[4];
const at = "2026-10-10T12:00:00Z";
const append = (rows: unknown[]) => fs.appendFileSync(path.join(root, "native.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const input = readline.createInterface({ input: process.stdin });
let running = false;

for await (const line of input) {
  const frame = JSON.parse(line) as Record<string, unknown>;
  if (frame.type !== "user" || running) continue;
  running = true;
  const uuid = "succession-native-prompt";
  const message = frame.message as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify({ type: "user", session_id: sessionId, uuid, message })}\n`);
  if (mode === "anchor") {
    // Keep the native process alive after its owner's stdio disappears. It
    // writes its terminal to the native artifact without a surviving broker.
    setInterval(() => {}, 1000);
    const call = { type: "assistant", uuid: "native-call", parentUuid: uuid, timestamp: at, message: { role: "assistant", model: "fixture", content: [{ type: "tool_use", id: "tool-one", name: "Read", input: {} }] } };
    const output = { type: "user", session_id: sessionId, uuid: "native-tool-output", parentUuid: "native-call", timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-one", content: "done" }] } };
    append([{ type: "user", uuid, timestamp: at, message }, call, output]);
    process.stdout.write(JSON.stringify(output) + "\n");
    const terminal = setInterval(() => {
      if (!fs.existsSync(path.join(root, "allow-terminal"))) return;
      clearInterval(terminal);
      append([{ type: "assistant", uuid: "native-final", parentUuid: "native-tool-output", timestamp: at, message: { role: "assistant", model: "fixture", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }]);
      fs.writeFileSync(path.join(root, "terminal-written"), "done");
    }, 5);
    continue;
  }
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "task_started", task_id: "succession-background" })}\n`);
  fs.appendFileSync(path.join(root, "tool-starts"), "start\n");
  const tool = spawn(process.execPath, ["-e", 'const fs = require("node:fs"); const gate = process.argv[1]; const done = process.argv[2]; const poll = setInterval(() => { if (!fs.existsSync(gate)) return; clearInterval(poll); fs.writeFileSync(done, "done"); }, 5)', path.join(root, "allow-tool-completion"), path.join(root, "tool-done")], {
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(root, "tool.pid"), String(tool.pid));
  if (mode) {
    if (mode === "cost") fs.writeFileSync(path.join(root, "native.jsonl"), (JSON.stringify({ type: "metadata", padding: "x".repeat(1000) }) + "\n").repeat(4096));
    append([
      { type: "user", uuid, timestamp: at, message },
      { type: "assistant", uuid: "fixture-tool", timestamp: at, message: { role: "assistant", model: "fixture", content: [{ type: "tool_use", id: "tool-gate", name: "Bash", input: { run_in_background: true } }] } },
      { type: "user", uuid: "fixture-tool-result", timestamp: at, toolUseResult: { backgroundTaskId: "fixturebackground" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-gate", content: "Command running in background with ID: fixturebackground." }] } },
      { type: "assistant", uuid: "fixture-end", timestamp: at, message: { role: "assistant", model: "fixture", stop_reason: "end_turn", content: [{ type: "text", text: "Waiting for background work." }] } },
    ]);
    const foreground = setInterval(() => {
      if (mode !== "idle" && !fs.existsSync(path.join(root, "allow-foreground-completion"))) return;
      clearInterval(foreground);
      process.stdout.write(JSON.stringify({ type: "result", uuid: "foreground-result", session_id: sessionId, subtype: "success", is_error: false }) + "\n");
      fs.writeFileSync(path.join(root, "foreground-ended"), "done");
    }, 5);
  } else append([{ type: "user", uuid, timestamp: at, message }]);
  const poll = setInterval(async () => {
    if (!fs.existsSync(path.join(root, "tool-done"))) return;
    clearInterval(poll);
    if (mode) append([{ type: "user", uuid: "fixture-notice", timestamp: at, message: { role: "user", content: "<task-notification><task-id>fixturebackground</task-id><status>completed</status></task-notification>" } }]);
    if (mode && fs.existsSync(path.join(root, "hold-result"))) {
      fs.writeFileSync(path.join(root, "notice-written"), "done");
      while (!fs.existsSync(path.join(root, "allow-result"))) await new Promise(resolve => setTimeout(resolve, 5));
    }
    const answer = { type: "assistant", uuid: "background-answer", session_id: sessionId, timestamp: at,
      ...(mode ? { user_message_uuid: "fixture-notice" } : {}),
      message: { id: "succession-answer", role: "assistant", model: "fixture", stop_reason: "end_turn", content: [{ type: "text", text: "background result" }] } };
    append([answer]);
    if (mode && fs.existsSync(path.join(root, "hold-delivery"))) {
      fs.writeFileSync(path.join(root, "native-terminal-written"), "done");
      while (!fs.existsSync(path.join(root, "allow-delivery"))) await new Promise(resolve => setTimeout(resolve, 5));
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    process.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", is_error: false })}\n`);
  }, 10);
}
