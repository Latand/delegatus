import crypto from "node:crypto";

import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { buildFeed, copilotFeedToolName, type Item } from "./parse";

/*
 * The GitHub Copilot feed renderer (docs/design/copilot-engine.md 3.2). The
 * record shapes follow `events.jsonl` as Copilot CLI 1.0.87 writes it in a
 * BYOK run: `{type, data, id, timestamp, parentId}`. Session, message and
 * interaction ids are generated here when the test runs; paths and bodies are
 * invented.
 */

const copilotFile = {
  path: "/srv/fixture/.copilot/session-state/session/events.jsonl",
  engine: "copilot",
  fmt: "copilot",
  activity: "recent",
} as FileEntry;

const AT = "2026-09-22T20:00:00.000Z";
const id = () => crypto.randomUUID();

function record(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data, id: id(), timestamp: AT, parentId: null });
}

function render(lines: string[], showSvc = false): Item[] {
  return buildFeed(copilotFile, lines, showSvc, "").items;
}

function transcript(): string[] {
  const sessionId = id();
  const interaction = id();
  const firstMessage = id();
  return [
    record("session.start", {
      sessionId,
      version: 1,
      producer: "copilot-agent",
      copilotVersion: "1.0.87",
      startTime: AT,
      selectedModel: "gpt-5.4",
      reasoningEffort: "xhigh",
      context: { cwd: "/srv/fixture/repo" },
      alreadyInUse: false,
    }),
    record("user.message", {
      content: "run the check",
      transformedContent: "<current_datetime>2026-09-22T23:00:00+03:00</current_datetime>\n\nrun the check",
      messageId: firstMessage,
      interactionId: interaction,
      turnId: "0",
      delivery: "idle",
    }),
    record("system.message", { role: "system", content: "You are GitHub Copilot." }),
    record("assistant.turn_start", { turnId: "0", interactionId: interaction }),
    record("assistant.message", {
      messageId: id(),
      originatingMessageId: firstMessage,
      model: "gpt-5.4",
      content: "",
      toolRequests: [
        { toolCallId: "call_shell", name: "bash", arguments: { command: "echo fixture-output", description: "echo" }, type: "function" },
        { toolCallId: "call_viewer", name: "viewer-list_tasks", arguments: { openOnly: true }, type: "function" },
      ],
      interactionId: interaction,
      turnId: "0",
    }),
    record("tool.execution_start", { toolCallId: "call_shell", toolName: "bash", arguments: { command: "echo fixture-output", description: "echo" }, turnId: "0" }),
    record("tool.execution_complete", {
      toolCallId: "call_shell",
      success: true,
      shellExecution: { exitCode: 0 },
      result: { content: "fixture-output\n<shellId: 0 completed with exit code 0>" },
    }),
    record("tool.execution_complete", {
      toolCallId: "call_viewer",
      success: false,
      result: { content: "tool refused" },
    }),
    record("assistant.turn_end", { turnId: "0" }),
    record("assistant.turn_start", { turnId: "1", interactionId: interaction }),
    record("assistant.message", {
      messageId: id(),
      originatingMessageId: firstMessage,
      model: "gpt-5.4",
      content: "The check printed fixture-output.",
      toolRequests: [],
      interactionId: interaction,
      turnId: "1",
    }),
    record("assistant.turn_end", { turnId: "1" }),
    record("user.message", { content: "a long task", messageId: id(), interactionId: id(), turnId: "0", delivery: "idle" }),
    record("assistant.turn_start", { turnId: "0" }),
    record("abort", { reason: "user_initiated" }),
    record("assistant.turn_end", { turnId: "0" }),
    record("user.message", { content: "new direction", messageId: id(), interactionId: id(), turnId: "0", delivery: "idle" }),
    record("session.shutdown", { shutdownType: "routine", totalPremiumRequests: 0, totalNanoAiu: 0, modelMetrics: {} }),
  ];
}

test("Copilot records map onto user, assistant, tool, result and interrupted rows", () => {
  const items = render(transcript());
  const kinds = items.map((item) => item.kind);
  expect(kinds.filter((kind) => kind === "user")).toHaveLength(3);
  const users = items.filter((item): item is Extract<Item, { kind: "user" }> => item.kind === "user");
  /* The datetime preamble the CLI adds is never the prompt. */
  expect(users.map((user) => user.text)).toEqual(["run the check", "a long task", "new direction"]);
  const prose = items.filter((item): item is Extract<Item, { kind: "prose" }> => item.kind === "prose");
  expect(prose.map((item) => item.text)).toEqual(["The check printed fixture-output."]);
  expect(prose[0]!.engine).toBe("copilot");

  const tools = items.filter((item) => item.kind === "tool") as Array<Extract<Item, { kind: "tool" }>>;
  expect(tools.map((tool) => tool.tool)).toEqual(["Bash", "mcp__viewer__list_tasks"]);
  const shell = tools[0]!;
  expect(shell.id).toBe("call_shell");
  expect(shell.status).toBe("ok");
  expect(shell.command).toBe("echo fixture-output");
  /* A Viewer MCP call reads as the Viewer MCP tool, the same path as Claude's. */
  expect(tools[1]!.mcp).toMatchObject({ serverName: "viewer", toolName: "list_tasks" });
  expect(tools[1]!.status).toBe("err");

  const interrupted = items.filter((item) => item.kind === "note");
  expect(interrupted).toHaveLength(1);
  /* The system prompt, turn boundaries and usage records are not rows. */
  expect(JSON.stringify(items)).not.toContain("You are GitHub Copilot.");
});

test("an execution_start without a prior tool request still opens the tool card once", () => {
  const items = render([
    record("tool.execution_start", { toolCallId: "call_solo", toolName: "view", arguments: { path: "/srv/fixture/repo/README.md" } }),
    record("tool.execution_start", { toolCallId: "call_solo", toolName: "view", arguments: { path: "/srv/fixture/repo/README.md" } }),
    record("tool.execution_complete", { toolCallId: "call_solo", success: true, result: { content: "# readme" } }),
  ]);
  const tools = items.filter((item) => item.kind === "tool") as Array<Extract<Item, { kind: "tool" }>>;
  expect(tools).toHaveLength(1);
  expect(tools[0]!.tool).toBe("Read");
  expect(tools[0]!.status).toBe("ok");
});

test("an unknown record type and a truncated last line degrade to nothing, not a broken feed", () => {
  const lines = transcript().slice(0, 2);
  const items = render([
    ...lines,
    record("session.some_future_record", { anything: true }),
    '{"type":"assistant.message","data":{"content":"cut o',
  ]);
  expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
  expect(items.some((item) => item.kind === "prose")).toBe(false);
});

test("service rows name the model and effort when service rows are shown", () => {
  const items = render(transcript().slice(0, 1), true);
  expect(items.some((item) => item.kind === "svc" && item.text.includes("gpt-5.4 · xhigh"))).toBe(true);
});

test("Copilot tool names map onto the shared vocabulary", () => {
  expect(copilotFeedToolName("bash")).toBe("Bash");
  expect(copilotFeedToolName("rg")).toBe("Grep");
  expect(copilotFeedToolName("viewer-send_message")).toBe("mcp__viewer__send_message");
  expect(copilotFeedToolName("some_new_tool")).toBe("some_new_tool");
});

/* #2075: Copilot writes a viewed picture's bytes once, as a
   `session.binary_asset` ahead of the completion, and the completion's
   `binaryResultsForLlm` names the asset without its data. */
function viewedImage(withAsset: boolean): string[] {
  const call = "call-view";
  return [
    record("tool.execution_start", { toolCallId: call, toolName: "view", arguments: { path: "/w/shot.png" } }),
    ...(withAsset
      ? [record("session.binary_asset", { assetId: "sha256:ab", type: "image", mimeType: "image/png", byteLength: 8, data: "iVBORw0KGgo=", description: "shot.png" })]
      : []),
    record("tool.execution_complete", {
      toolCallId: call,
      success: true,
      result: { content: "Viewed image file successfully.", binaryResultsForLlm: [{ assetId: "sha256:ab", type: "image", mimeType: "image/png" }] },
    }),
  ];
}

test("a Copilot view of an image draws the asset's picture on the call's row", () => {
  const view = render(viewedImage(true)).find((item) => item.kind === "tool");
  if (view?.kind !== "tool") throw new Error("expected the view row");
  expect(view.outputBlocks).toEqual([
    { type: "text", text: "Viewed image file successfully." },
    { type: "image", media: "image/png", data: "iVBORw0KGgo=" },
  ]);
  expect(JSON.stringify(render(viewedImage(true)))).not.toContain("sha256:ab");
});

test("a Copilot view whose asset fell out of the window draws the viewed file by path", () => {
  const view = render(viewedImage(false)).find((item) => item.kind === "tool");
  if (view?.kind !== "tool") throw new Error("expected the view row");
  expect(view.outputBlocks?.filter((block) => block.type === "image")).toEqual([{ type: "image", path: "/w/shot.png" }]);
});
