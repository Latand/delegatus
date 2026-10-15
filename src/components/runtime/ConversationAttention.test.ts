import { describe, expect, test } from "bun:test";

import { CodexPinnedProtocol } from "@/lib/accounts/codexPinnedProtocol";
import { decodeCodexServerRequest, encodeCodexServerResponse } from "@/lib/runtime/codexServerRequests";
import { projectEngineHostEvent } from "@/lib/runtime/engineHostEvents";

import type { RuntimeAttention } from "./runtimeModel";
import { approvalResolution, questionResolution, questionsResolution } from "./ConversationAttention";

function attention(engine: "codex" | "claude"): RuntimeAttention {
  return {
    id: "question-one",
    conversationId: "conversation-one",
    kind: "question",
    state: "open",
    unowned: false,
    createdAt: "2026-07-14T00:00:00.000Z",
    request: {
      question: { prompt: "Continue?", options: [{ label: "Yes" }] },
      protocol: {
        engine,
        method: engine === "codex" ? "item/tool/requestUserInput" : "control_request",
        questionId: "scope",
        input: { questions: [{ question: "Continue?" }] },
      },
    },
  };
}

test("Codex question cards emit requestUserInput answers", () => {
  expect(questionResolution(attention("codex"), 0)).toEqual({
    answers: { scope: { answers: ["Yes"] } },
  });
});

test("Claude question cards emit permission-tool input updates", () => {
  expect(questionResolution(attention("claude"), 0)).toEqual({
    behavior: "allow",
    updatedInput: { questions: [{ question: "Continue?" }], answers: { "Continue?": "Yes" } },
  });
});

test("Codex multi-question cards return every selected answer", () => {
  const request = attention("codex");
  request.request.questions = [
    { prompt: "First?", options: [{ label: "One" }] },
    { prompt: "Second?", options: [{ label: "Two" }, { label: "Three" }], multiSelect: true },
  ];
  request.request.protocol!.questionIds = ["first", "second"];
  expect(questionsResolution(request, [[0], [0, 1]])).toEqual({
    answers: {
      first: { answers: ["One"] },
      second: { answers: ["Two", "Three"] },
    },
  });
});

test("subscription host approval responses match each engine protocol", () => {
  expect(approvalResolution(attention("codex"), true)).toEqual({ decision: "accept" });
  expect(approvalResolution(attention("claude"), true)).toEqual({ behavior: "allow" });
  expect(approvalResolution(attention("claude"), false)).toEqual({ behavior: "deny", message: "Denied in Viewer" });
});

test("Codex responses keep original option labels and custom answers under their exact question ids", () => {
  const request = attention("codex");
  request.request.questions = [
    { prompt: "Pick one", options: [{ label: "Clipped…" }] },
    { prompt: "Enter value", isOther: true, isSecret: true },
  ];
  request.request.protocol!.questionIds = ["choice-id", "secret-id"];
  request.request.protocol!.questionOptions = [["Original complete option label"], []];
  expect(questionsResolution(request, [[0], []], ["", "custom value"])).toEqual({ answers: {
    "choice-id": { answers: ["Original complete option label"] }, "secret-id": { answers: ["custom value"] },
  } });
});

describe.each(["0.154.0", "0.159.0", "0.162.1"])("Codex %s projected question responses", version => {
  test.each(["", " \t\n"])("keeps visible choices aligned when blank labels are %j", blank => {
    const protocol = new CodexPinnedProtocol(version);
    const method = "item/tool/requestUserInput";
    const longLabel = `  ${"Keep changes ".repeat(40)}  `;
    const labels = [blank, "Keep", blank, longLabel, blank, "Later"];
    const decoded = decodeCodexServerRequest(protocol, 7, method, {
      threadId: "thread-one", turnId: "turn-one", itemId: "item-one", isBlocking: true,
      questions: [{
        id: "choice", header: "Choice", question: "Choose an action", isOther: false, isSecret: false,
        options: labels.map(label => ({ label, description: "Offered action" })),
      }],
    });
    const projected = projectEngineHostEvent("conversation-one", "codex:thread-one", {
      kind: "attention", id: "question-one", method, attention: decoded.params, seq: 1,
    });
    const request = projected!.payload as unknown as RuntimeAttention;
    const visible = request.request.question!.options!;
    expect(visible).toHaveLength(3);
    expect(visible[0]!.label).toBe("Keep");
    expect(visible[1]!.label).toEndWith("…");
    expect(visible[1]!.label.length).toBeLessThan(longLabel.length);
    expect(visible[2]!.label).toBe("Later");

    for (const [index, label] of ["Keep", longLabel, "Later"].entries()) {
      const resolution = questionResolution(request, index);
      expect(resolution).toEqual({ answers: { choice: { answers: [label] } } });
      expect(encodeCodexServerResponse(protocol, method, resolution, decoded.params)).toEqual(resolution);
    }
  });
});
