import fs from "node:fs";
import readline from "node:readline";

const root = process.env.VOICE_STUB_ROOT;
const mode = process.env.VOICE_STUB_MODE;
fs.writeFileSync(`${root}/pid`, String(process.pid));
fs.writeFileSync(`${root}/env`, JSON.stringify(Object.keys(process.env)));
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const note = (method, params) => send({ method, params });
const threadId = "voice_thread";
const readArgs = { project: null, statuses: null, openOnly: true, query: null, ids: null, cursor: null, limit: null, refresh: null };
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(`${root}/wire`, `${line}\n`);
  if (!message.method) return;
  let result = {};
  if (message.method === "account/read") result = { account: { type: mode === "auth" ? "apiKey" : "chatgpt", planType: "pro", email: "withheld" }, requiresOpenaiAuth: true };
  if (message.method === "account/rateLimits/read") result = { rateLimits: { primary: { usedPercent: mode === "limit" ? 100 : 10, resetsAt: 2000000000, windowDurationMins: 300 }, secondary: null, planType: "pro" } };
  if (message.method === "thread/start") result = { thread: { id: threadId } };
  if (message.id !== undefined) send({ id: message.id, result });
  if (message.method === "thread/realtime/start") {
    fs.writeFileSync(`${root}/ack`, "ready");
    if (mode === "error" || mode === "limit") note("thread/realtime/error", { threadId, message: "exceeded retry limit, last status: 429 Too Many Requests" });
    else {
      const timer = setInterval(() => {
        if (!fs.existsSync(`${root}/sdp`)) return;
        clearInterval(timer);
        note("thread/realtime/started", { threadId });
        note("thread/realtime/sdp", { threadId, sdp: "v=0\r\nanswer\r\n" });
        if (mode === "tools") {
          for (let index = 0; index < 2; index++) setTimeout(() => {
            note("thread/realtime/itemAdded", { threadId, item: { type: "handoff_request", handoff_id: `handoff_${index}`, input_transcript: "Read the open tasks on the board" } });
            send({ id: `request_${index}`, method: "item/tool/call", params: { threadId, turnId: `turn_${index}`, callId: `call_${index}`, tool: "list_tasks", arguments: readArgs } });
          }, 40 + index * 100);
          setTimeout(() => send({ id: "end_request", method: "item/tool/call", params: { threadId, turnId: "turn_1", callId: "end_call", tool: "end_conversation", arguments: {} } }), 240);
        }
      }, 10);
    }
  }
  if (message.method === "thread/realtime/stop") note("thread/realtime/closed", { threadId, reason: "requested" });
});
