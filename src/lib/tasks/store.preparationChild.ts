/** A real Viewer and task worker in an operator-shaped, wholly private home. */
import fs from "node:fs";
import path from "node:path";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

const [root, mode] = process.argv.slice(2);
if (!root || !["owner", "refused"].includes(mode!)) throw new Error("private preparation fixture arguments required");
const home = path.join(root, "operator-home"), temp = path.join(root, "temp");
const state = path.join(home, ".config/delegatus/state");
assert(!fs.existsSync(state), "fixture state must be new");
for (const directory of [temp, state, path.join(home, ".codex"), path.join(home, ".claude")]) fs.mkdirSync(directory, { recursive: true });
Object.assign(process.env, { NODE_ENV: "production", LLV_STATE_OWNER: "viewer", HOME: home, TMPDIR: temp,
  XDG_CONFIG_HOME: path.join(home, ".config"), LLV_STATE_DIR: state, LLV_CODEX_HOME: path.join(home, ".codex"),
  LLV_CLAUDE_HOME: path.join(home, ".claude"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", PORT: "", LLV_TOKEN: "" });
const { setStateOwnershipPathsForTests, mayRunStateStartupMutation } = await import("../stateOwnership");
setStateOwnershipPathsForTests({ home, tempRoots: [root!] });
const { openStateMutationActivation } = await import("../state/stateMutationBarrier");
openStateMutationActivation();
const { stateWriterChild } = await import("../../../scripts/mcp-state-writer-benchmark");
process.env.MCP_BENCH_READY = path.join(root, "capabilities.json");
Object.assign(process.env, { NODE_ENV: "test" });
try { await stateWriterChild("seed"); } finally { Object.assign(process.env, { NODE_ENV: "production" }); }
setStateOwnershipPathsForTests({ home, tempRoots: [temp] });
const { openAsyncMcpReceiptStore } = await import("../mcp/server");
(await openAsyncMcpReceiptStore(path.join(state, "mcp-receipts.sqlite"), { legacyFilePath: path.join(state, "mcp-receipts.json") })).close();
const worker = path.join(root, "worker.ts");
fs.writeFileSync(worker, [
  `const {setStateOwnershipPathsForTests,mayRunStateStartupMutation}=await import(${JSON.stringify(path.resolve("src/lib/stateOwnership.ts"))});`,
  `setStateOwnershipPathsForTests({home:${JSON.stringify(home)},tempRoots:[${JSON.stringify(temp)}]});`,
  `if(mayRunStateStartupMutation(${JSON.stringify(state)}))throw new Error("fixture worker unexpectedly owns startup");`,
  `await import(${JSON.stringify(path.resolve("src/lib/mcpTask.worker.ts"))});`,
].join("\n"));
const { McpTaskExecutor } = await import("../mcp/taskExecutor");
const { callTaskChannel, decodeTaskChannel, TASK_CHANNEL_HEADER, TASK_CHANNEL_REQUEST_HEADER } = await import("../mcp/taskChannel");
const { persistProjectAliases } = await import("../projects/aliases");
const { Database } = await import("bun:sqlite");
const db = new Database(path.join(state, "state.sqlite"), { readonly: true });
const taskHash = () => createHash("sha256").update(JSON.stringify(db.query("SELECT row_key,value_json,row_revision FROM state_rows WHERE collection='tasks' ORDER BY row_order,row_key").all())).digest("hex");
const capability = (JSON.parse(fs.readFileSync(process.env.MCP_BENCH_READY!, "utf8")) as string[])[0]!;
const executor = new McpTaskExecutor({ launch: { executable: process.execPath, workerPath: worker }, env: { LLV_STATE_DIR: state, PORT: "" } });
const taskId = ["00000000", "0000", "4000", "8000", "0".repeat(12)].join("-");
let preparations = 0;
const warn = console.warn;
console.warn = (message: unknown, ...rest: unknown[]) => {
  if (typeof message === "string" && message.startsWith("[tasks preparation] ")) {
    preparations++;
    if (mode === "owner" && preparations === 1) assert(persistProjectAliases([{ source: "reply-race", target: "fixture", displayName: "Fixture" }]));
  }
  warn(message, ...rest);
};
try {
  const body = { jsonrpc: "2.0", id: "initial", method: "tools/call", params: { name: "get_task", arguments: { taskId } } };
  const request = new Request("http://127.0.0.1/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", [TASK_CHANNEL_REQUEST_HEADER]: "1" }, body: JSON.stringify(body) });
  const initial = await executor.callHttpTool("get_task", body, request, { capability }, { deadlineAt: Date.now() + 30_000 });
  const channel = decodeTaskChannel(initial.headers.get(TASK_CHANNEL_HEADER));
  assert.equal(initial.status, 200); await initial.text(); assert(channel);
  const marker = path.join(state, "tasks-row-preparation.json");
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  const before = taskHash();
  if (mode === "refused") process.env.LLV_STATE_OWNER = "tool";
  assert.equal(mayRunStateStartupMutation(state), mode === "owner");
  const edit = async (key: string) => {
    const response = await callTaskChannel(channel, JSON.stringify({ jsonrpc: "2.0", id: key, method: "tools/call", params: { name: "update_task", arguments: { taskId, note: key, clientRequestId: key, full: true } } }), capability,
      new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }), Date.now() + 30_000, new AbortController().signal);
    const answer = await response.json() as { result: { structuredContent: { ok: boolean; task?: { note?: { text: string } } } } };
    assert.equal(response.status, 200);
    return answer.result.structuredContent;
  };
  const first = await edit("owner-preparation");
  assert.equal(first.ok, mode === "owner");
  if (mode === "owner") {
    assert.equal(first.task?.note?.text, "owner-preparation");
    assert(fs.existsSync(marker));
    assert(persistProjectAliases([{ source: "unused-alias", target: "fixture", displayName: "Fixture" }]));
    assert.equal((await edit("alias-preparation")).task?.note?.text, "alias-preparation");
    assert.equal((await edit("prepared-again")).task?.note?.text, "prepared-again");
    assert.equal(preparations, 3);
  } else {
    assert.equal(taskHash(), before);
    assert(!fs.existsSync(marker));
    assert.equal(preparations, 0);
  }
  console.log(JSON.stringify({ mode, privateChannel: true, workerStartupAuthority: false, preparations, boardUnchangedOnRefusal: mode === "refused" }));
} finally { console.warn = warn; await executor.close(); db.close(); }
