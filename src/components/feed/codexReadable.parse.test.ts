import { expect, test } from "bun:test";
import type { FileEntry } from "@/lib/types";
import { buildFeed, createFeedSession, type ToolEvent } from "./parse";
import { currentCodexToolLines } from "./__fixtures__/readableTools";

const file = { path: "/workspace/demo.jsonl", engine: "codex", fmt: "codex", cwd: "/workspace/app" } as FileEntry;
const feed = () => buildFeed(file, currentCodexToolLines(), false, "").items;
const calls = (): ToolEvent[] => feed().flatMap(x => x.kind === "cmd-group" ? x.calls : x.kind === "tool" ? [x] : []);

test("current exec wrapper has one row per concrete operation", () => {
  expect(calls().some(x => x.id === "wrapper")).toBe(false);
  const shell = calls().find(x => x.id === "exec-shell")!;
  expect(shell.command).toBe("git status --short");
  expect(shell.cwd).toBe("/workspace/build");
  expect(shell.exitCode).toBe(0);
  expect(shell.durationMs).toBe(240);
  expect(shell.outputPreview).toContain("src/demo.ts");
});
test("extension is a named web action with readable results", () => {
  const web = calls().find(x => x.id === "exec-web")!;
  expect(web.family).toBe("web");
  expect(web.tool).not.toBe("Extension");
  expect(web.summary).toContain("release guide");
  expect(web.outputPreview).toContain("https://example.org/guide");
});
test("MCP summary prioritizes useful arguments over correlation metadata", () => {
  const mcp = calls().find(x => x.id === "exec-mcp")!;
  expect(mcp.summary).toContain("catalog · lookup · release notes");
  expect(mcp.chips.some(x => x.value === "3")).toBe(true);
});
test("follow-up and lifecycle retain agent, task and outcome without loose notes", () => {
  const follow = calls().find(x => x.id === "follow")!;
  expect(follow.family).toBe("spawn");
  expect(follow.summary).toContain("auditor");
  expect(follow.summary).toContain("Check retry behaviour");
  expect(JSON.stringify(feed())).toContain("completed");
  expect(feed().some(x => x.kind === "note")).toBe(false);
});
test("typed patches retain paths and added/removed counts", () => {
  const patch = calls().find(x => x.id === "exec-patch")!;
  expect(patch.summary).toContain("+1 −1");
  expect(patch.body?.files[0].path).toBe("src/demo.ts");
});

const response = (payload: object) => JSON.stringify({ type: "response_item", payload });
const typed = (item: object, type = "item_completed") => JSON.stringify({ type: "event_msg", payload: { type, item } });
const flatten = (lines: string[]) => buildFeed(file, lines, false, "").items.flatMap(x => x.kind === "cmd-group" ? x.calls : x.kind === "tool" ? [x] : []);
const wrapper = response({ type: "custom_tool_call", call_id: "outer", name: "exec", input: 'text(await tools.exec_command({cmd:"echo hello"}));' });
const shell = typed({ type: "CommandExecution", id: "exec-child", command: ["sh", "-c", "echo hello"], status: "completed", exit_code: 0, stdout: "hello" });
const result = response({ type: "custom_tool_call_output", call_id: "outer", output: "Script completed\nOutput:\nhello" });

test("legacy source-only exec and incomplete or failed wrappers retain their evidence", () => {
  expect(flatten([wrapper, result]).map(x => x.id)).toEqual(["outer"]);
  const mixed = JSON.parse(wrapper);
  mixed.payload.input += 'text(await tools.unknown_operation({}));';
  expect(flatten([JSON.stringify(mixed), shell, result]).map(x => x.id)).toEqual(["outer", "exec-child"]);
  const failure = JSON.parse(result); failure.payload.output = "Error: wrapper failed";
  expect(flatten([wrapper, shell, JSON.stringify(failure)]).map(x => x.id)).toEqual(["outer", "exec-child"]);
});
test("repeated child lifecycle, append and window slides equal fresh parsing", () => {
  const started = JSON.parse(shell); started.payload.type = "item_started"; started.payload.item.status = "inProgress";
  const lines = [wrapper, JSON.stringify(started), shell, result];
  const session = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
  for (let n = 1; n <= lines.length; n++) session.feed(lines.slice(0, n), 0, true);
  expect(session.feed(lines, 0, false).items.map(x => x.item)).toEqual(buildFeed(file, lines, false, "").items);
  expect(flatten(lines).map(x => x.id)).toEqual(["exec-child"]);
  for (let start = 1; start < lines.length; start++) {
    const fresh = createFeedSession({ engine: "codex", fmt: "codex", showSvc: false, lineFilter: "" });
    expect(session.feed(lines.slice(start), start, false).items.map(x => x.item)).toEqual(fresh.feed(lines.slice(start), start, false).items.map(x => x.item));
  }
});
test("different turn or unrelated child identities never consume a wrapper", () => {
  const unrelated = JSON.parse(shell); unrelated.payload.item.id = "standalone";
  expect(flatten([wrapper, JSON.stringify(unrelated), result])).toHaveLength(2);
  expect(flatten([wrapper, JSON.stringify({ type: "turn_context", payload: {} }), shell, result])).toHaveLength(2);
});
test("patch wrapper and concrete patch count as one logical change", () => {
  const patch = "*** Begin Patch\n*** Update File: src/demo.ts\n@@\n-old\n+new\n*** End Patch";
  const wrap = response({ type: "custom_tool_call", call_id: "outer", name: "exec", input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` });
  const change = typed({ type: "FileChange", id: "exec-change", status: "completed", changes: { "src/demo.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new" } } });
  expect(flatten([wrap, change, result])).toHaveLength(1);
  expect(flatten([wrap, change, result])[0].summary).toContain("+1 −1");
});
test("MCP wrapper and typed result share one readable call", () => {
  const wrap = response({ type: "custom_tool_call", call_id: "outer", name: "exec", input: 'text(await tools.mcp__catalog__lookup({query:"releases"}));' });
  const call = typed({ type: "McpToolCall", id: "exec-catalog", server: "catalog", tool: "lookup", arguments: { query: "releases" }, status: "completed", result: { content: [{ type: "text", text: "Found releases" }] } });
  const tools = flatten([wrap, call, result]);
  expect(tools).toHaveLength(1);
  expect(tools[0].outputPreview).toBe("Found releases");
});
test("MCP and shell arguments use contextual feed redaction", () => {
  const key = ["api", "key"].join("_"); const sentinel = "invented-sensitive-value";
  const call = typed({ type: "McpToolCall", id: "secret-mcp", server: "catalog", tool: "lookup", arguments: { [key]: sentinel, query: "releases" }, status: "completed" });
  expect(JSON.stringify(flatten([call]))).not.toContain(sentinel);
  const command = response({ type: "function_call", call_id: "secret-shell", name: "exec_command", arguments: JSON.stringify({ cmd: `env ${key}=${sentinel} verify` }) });
  expect(JSON.stringify(flatten([command]))).not.toContain(sentinel);
});
test("encrypted follow-up text is acknowledged without exposing the ciphertext", () => {
  const cipher = "gAAAAA" + "abcD123_".repeat(20);
  const call = response({ type: "function_call", name: "followup_task", call_id: "encrypted", arguments: JSON.stringify({ target: "auditor", message: cipher }) });
  expect(flatten([call])[0].summary).toContain("Task text unavailable");
  expect(JSON.stringify(flatten([call]))).not.toContain(cipher);
});
test("same conversation cwd is omitted, different cwd is visible", () => {
  const same = JSON.parse(shell); same.payload.item.cwd = "/workspace/app";
  expect(flatten([JSON.stringify(same)])[0].cwd).toBeUndefined();
  same.payload.item.cwd = "/workspace/build";
  expect(flatten([JSON.stringify(same)])[0].cwd).toBe("/workspace/build");
});

test("overlapping wrappers cannot claim each other's concrete children", () => {
  const second = JSON.parse(wrapper); second.payload.call_id = "second";
  const secondResult = JSON.parse(result); secondResult.payload.call_id = "second";
  const tools = flatten([wrapper, JSON.stringify(second), shell, JSON.stringify(secondResult), result]);
  expect(tools.map(x => x.id)).toEqual(["outer", "second", "exec-child"]);
});

test("large patch source still pairs within the bounded correlation budget", () => {
  const patch = "*** Begin Patch\n*** Add File: src/large.ts\n+" + "x".repeat(12000) + "\n*** End Patch";
  const wrap = response({ type: "custom_tool_call", call_id: "outer", name: "exec", input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` });
  const change = typed({ type: "FileChange", id: "exec-large", status: "completed", changes: { "src/large.ts": { type: "add", content: "x".repeat(12000) } } });
  expect(flatten([wrap, change, result])).toHaveLength(1);
});
