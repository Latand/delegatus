import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { readSession } from "@/lib/session/reader";

import {
  copilotHeadFromRecords,
  copilotSessionIdFromPath,
  copilotTurnState,
  copilotWorkspaceTitle,
  isCopilotTranscriptPath,
} from "./copilotNative";

/* Copilot CLI 1.0.87 record shapes; ids are generated when the test runs. */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-copilot-native-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const AT = "2026-09-22T20:00:00.000Z";
const rec = (type: string, data: Record<string, unknown> = {}) => ({ type, data, id: crypto.randomUUID(), timestamp: AT, parentId: null });

test("only a session directory's own events.jsonl is a transcript", () => {
  const root = path.join(sandbox, "session-state");
  const session = crypto.randomUUID();
  expect(isCopilotTranscriptPath(root, path.join(root, session, "events.jsonl"))).toBe(true);
  expect(isCopilotTranscriptPath(root, path.join(root, session, "checkpoints", "events.jsonl"))).toBe(false);
  expect(isCopilotTranscriptPath(root, path.join(root, session, "research", "notes.jsonl"))).toBe(false);
  expect(isCopilotTranscriptPath(root, path.join(root, "not-a-session", "events.jsonl"))).toBe(false);
  expect(copilotSessionIdFromPath(path.join(root, session.toUpperCase(), "events.jsonl"))).toBe(session);
  expect(copilotSessionIdFromPath(path.join(root, session, "workspace.yaml"))).toBeNull();
});

test("a turn that requested tools is still running at its turn_end; the answer closes it", () => {
  const user = rec("user.message", { content: "go" });
  const toolTurn = [rec("assistant.turn_start"), rec("assistant.message", { content: "", toolRequests: [{ toolCallId: "c1", name: "bash" }] }), rec("tool.execution_start"), rec("tool.execution_complete"), rec("assistant.turn_end")];
  expect(copilotTurnState([user, ...toolTurn]).state).toBe("busy");
  const answer = [rec("assistant.turn_start"), rec("assistant.message", { content: "done", toolRequests: [] }), rec("assistant.turn_end")];
  expect(copilotTurnState([user, ...toolTurn, ...answer])).toEqual({ state: "terminal", source: "lifecycle", terminalAt: AT });
  /* The shared migration reader routes Copilot to the same rule. */
  expect(turnStateFromRecords([user, ...toolTurn], "copilot").state).toBe("busy");
});

test("an abort ends the turn; a message after it opens the next one", () => {
  const aborted = [rec("user.message", { content: "slow" }), rec("assistant.turn_start"), rec("abort", { reason: "user_initiated" }), rec("assistant.turn_end")];
  expect(copilotTurnState(aborted).state).toBe("terminal");
  expect(copilotTurnState([...aborted, rec("user.message", { content: "new direction" })]).state).toBe("busy");
  expect(copilotTurnState([]).state).toBe("unknown");
  expect(copilotTurnState([rec("some.future_record")]).state).toBe("unknown");
});

test("the head names cwd, model, effort, CLI version and first prompt", () => {
  const head = copilotHeadFromRecords([
    rec("session.start", { sessionId: "s", copilotVersion: "1.0.87", selectedModel: "gpt-5.4", reasoningEffort: "xhigh", context: { cwd: "/srv/fixture/repo" } }),
    rec("session.model_change", { newModel: "claude-sonnet-5", reasoningEffort: "high" }),
    rec("user.message", { content: "first prompt", transformedContent: "<current_datetime>x</current_datetime>\n\nfirst prompt" }),
    rec("user.message", { content: "second" }),
  ]);
  expect(head).toMatchObject({ cwd: "/srv/fixture/repo", model: "claude-sonnet-5", effort: "high", copilotVersion: "1.0.87", firstUserMessage: "first prompt" });
});

test("workspace.yaml names the session", () => {
  const dir = path.join(sandbox, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.yaml"), "id: x\ncwd: /srv/fixture/repo\nname: Fix the flaky test\nuser_named: false\n");
  expect(copilotWorkspaceTitle(path.join(dir, "events.jsonl"))).toBe("Fix the flaky test");
  expect(copilotWorkspaceTitle(path.join(sandbox, "missing", "events.jsonl"))).toBeNull();
});

test("the session reader turns a Copilot transcript into messages and tools", () => {
  const file = path.join(sandbox, crypto.randomUUID(), "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    rec("session.start", { context: { cwd: "/repo" } }),
    rec("user.message", { content: "run it" }),
    rec("system.message", { content: "system prompt" }),
    rec("assistant.message", { content: "", toolRequests: [{ toolCallId: "c1", name: "bash", arguments: { command: "ls" } }] }),
    rec("tool.execution_complete", { toolCallId: "c1", result: { content: "README.md" } }),
    rec("assistant.message", { content: "Listed.", toolRequests: [] }),
    rec("abort", { reason: "user_initiated" }),
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const session = readSession(file, "copilot");
  expect(session.messages.map((message) => [message.role, message.text])).toEqual([["user", "run it"], ["assistant", "Listed."]]);
  expect(session.tools.map((tool) => tool.kind)).toEqual(["tool_call", "tool_result"]);
  expect(session.traces.map((trace) => trace.name)).toEqual(["abort"]);
  expect(JSON.stringify(session)).not.toContain("system prompt");
});
