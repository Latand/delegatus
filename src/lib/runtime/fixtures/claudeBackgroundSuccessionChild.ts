import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const root = process.argv[2]!;
const sessionId = process.argv[3]!;
const input = readline.createInterface({ input: process.stdin });
let running = false;

for await (const line of input) {
  const frame = JSON.parse(line) as Record<string, unknown>;
  if (frame.type !== "user" || running) continue;
  running = true;
  const uuid = "succession-native-prompt";
  const message = frame.message as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify({ type: "user", session_id: sessionId, uuid, message })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "task_started", task_id: "succession-background" })}\n`);
  fs.appendFileSync(path.join(root, "tool-starts"), "start\n");
  const tool = spawn(process.execPath, ["-e", 'setTimeout(() => { require("node:fs").writeFileSync(process.argv[1], "done"); }, 5000)', path.join(root, "tool-done")], {
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(root, "tool.pid"), String(tool.pid));
  const poll = setInterval(() => {
    if (!fs.existsSync(path.join(root, "tool-done"))) return;
    clearInterval(poll);
    process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: sessionId, message: { id: "succession-answer", role: "assistant", model: "fixture", stop_reason: "end_turn", content: [{ type: "text", text: "background result" }] } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, subtype: "success", is_error: false })}\n`);
  }, 10);
}
