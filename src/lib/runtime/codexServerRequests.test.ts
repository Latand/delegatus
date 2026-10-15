import { codexAttentionActions } from "./codexAttentionActions";
import { describe, expect, test } from "bun:test";
import { CodexPinnedProtocol } from "@/lib/accounts/codexPinnedProtocol";
import { decodeCodexServerRequest, encodeCodexServerResponse } from "./codexServerRequests";

const command = "item/commandExecution/requestApproval";
const permission = "item/permissions/requestApproval";
const question = "item/tool/requestUserInput";
const identity = { threadId: "thread", turnId: "turn", itemId: "item" };
const approval = { ...identity, startedAtMs: 1, command: "echo example" };
const questions = { ...identity, isBlocking: true, questions: [
  { id: "first", header: "First", question: "Which?", isOther: false, isSecret: false, options: [{ label: "A", description: "First choice" }] },
  { id: "second", header: "Second", question: "Why?", isOther: true, isSecret: false, options: null },
] };

describe.each(["0.154.0", "0.159.0", "0.162.1"])("Codex %s request boundary", version => {
  const protocol = new CodexPinnedProtocol(version);
  test("decodes the complete request and refuses missing identity or malformed ingress", () => {
    expect(decodeCodexServerRequest(protocol, 7, command, approval)).toMatchObject({ id: 7, params: identity });
    for (const field of ["threadId", "turnId", "itemId", "startedAtMs"]) {
      const missing: Record<string, unknown> = { ...approval };
      delete missing[field];
      expect(() => decodeCodexServerRequest(protocol, 7, command, missing)).toThrow("server-params");
    }
    expect(() => decodeCodexServerRequest(protocol, Number.MAX_SAFE_INTEGER + 1, command, approval)).toThrow("safe integer");
    expect(() => decodeCodexServerRequest(protocol, "7", command, { ...approval, unexpected: true })).toThrow("server-params");
    expect(() => decodeCodexServerRequest(protocol, 7, "future/request", {})).toThrow("absent");
  });

  test("enforces offered decisions including session grants, cancel and exact amendments", () => {
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) {
      expect(encodeCodexServerResponse(protocol, command, { decision }, { ...approval, availableDecisions: [decision] })).toEqual({ decision });
      expect(() => encodeCodexServerResponse(protocol, command, { decision }, { ...approval, availableDecisions: [] })).toThrow("not offered");
    }
    const amendment = ["echo", "example"];
    const decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } };
    const params = { ...approval, proposedExecpolicyAmendment: amendment, availableDecisions: [decision] };
    expect(encodeCodexServerResponse(protocol, command, { decision }, params)).toEqual({ decision });
    expect(() => encodeCodexServerResponse(protocol, command, { decision }, approval)).toThrow("amendment was not offered");
    const network = { host: "example.test", action: "allow" };
    const networkDecision = { applyNetworkPolicyAmendment: { network_policy_amendment: network } };
    expect(encodeCodexServerResponse(protocol, command, { decision: networkDecision }, { ...approval, proposedNetworkPolicyAmendments: [network] })).toEqual({ decision: networkDecision });
    expect(() => encodeCodexServerResponse(protocol, command, { decision: networkDecision }, approval)).toThrow("network amendment");
    for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) {
      expect(encodeCodexServerResponse(protocol, "item/fileChange/requestApproval", { decision }, { ...identity, startedAtMs: 1 })).toEqual({ decision });
    }
  });

  test("every offered UI action encodes against its request, including legacy denial and proposed policy rules", () => {
    const params = { ...approval, proposedExecpolicyAmendment: ["echo"], proposedNetworkPolicyAmendments: [{ host: "example.test", action: "allow" }] };
    const actions = codexAttentionActions(command, params);
    expect(actions.map(action => action.kind)).toContain("execpolicy");
    expect(actions.map(action => action.kind)).toContain("network");
    for (const action of actions) expect(encodeCodexServerResponse(protocol, command, action.response, params)).toEqual(action.response);
    const legacy = { conversationId: "thread", callId: "call", command: ["echo"], cwd: "/workspace", parsedCmd: [] };
    for (const action of codexAttentionActions("execCommandApproval", legacy)) {
      expect(encodeCodexServerResponse(protocol, "execCommandApproval", action.response, legacy)).toEqual(action.response);
    }
    expect(() => encodeCodexServerResponse(protocol, "execCommandApproval", { decision: "approved_mcp_policy_amendment" }, legacy)).toThrow("did not offer");
  });

  test("requires exact question IDs, preserves free text and refuses unoffered choices", () => {
    const answers = { first: { answers: ["A"] }, second: { answers: ["A free answer"] } };
    expect(encodeCodexServerResponse(protocol, question, { answers }, questions)).toEqual({ answers });
    expect(() => encodeCodexServerResponse(protocol, question, { answers: { first: answers.first } }, questions)).toThrow("exactly");
    expect(() => encodeCodexServerResponse(protocol, question, { answers: { ...answers, extra: answers.first } }, questions)).toThrow("exactly");
    expect(() => encodeCodexServerResponse(protocol, question, { answers: { ...answers, first: { answers: ["B"] } } }, questions)).toThrow("not offered");
    expect(() => decodeCodexServerRequest(protocol, 1, question, { ...questions, questions: [questions.questions[0], questions.questions[0]] })).toThrow("unique");
  });

  test.each(["", " \t\n"])("refuses a blank prompt %j before projection can drop its question", blank => {
    const params = { ...questions, questions: [
      { ...questions.questions[0]!, question: blank },
      questions.questions[1]!,
    ] };
    expect(() => decodeCodexServerRequest(protocol, 1, question, params)).toThrow("question prompts must be nonempty");
  });

  test.each(["", " \t\n"])("refuses a list of blank labels %j when custom answers are forbidden", blank => {
    const choice = { ...questions.questions[0]!, options: [{ label: blank, description: "Offered choice" }] };
    const params = { ...questions, questions: [choice] };
    expect(() => decodeCodexServerRequest(protocol, 1, question, params)).toThrow("no visible choices or custom answer");

    const answer = { answers: { first: { answers: ["Custom choice"] } } };
    for (const offered of [{ ...choice, isOther: true }, { ...choice, options: null }, { ...choice, options: [] }]) {
      const decoded = decodeCodexServerRequest(protocol, 1, question, { ...params, questions: [offered] });
      expect(encodeCodexServerResponse(protocol, question, answer, decoded.params)).toEqual(answer);
    }
  });

  test("grants only requested permission scopes", () => {
    const permissions = { network: { enabled: true }, fileSystem: { read: ["/workspace/input"], write: ["/workspace/output"] } };
    const params = { ...approval, command: undefined, cwd: "/workspace", permissions };
    delete (params as Record<string, unknown>).command;
    for (const scope of ["turn", "session"]) {
      expect(encodeCodexServerResponse(protocol, permission, { permissions, scope }, params)).toEqual({ permissions, scope });
      expect(encodeCodexServerResponse(protocol, permission, { permissions: {}, scope }, params)).toEqual({ permissions: {}, scope });
    }
    expect(() => encodeCodexServerResponse(protocol, permission, { permissions, scope: "forever" }, params)).toThrow("result");
    expect(() => encodeCodexServerResponse(protocol, permission, { permissions: { fileSystem: { read: null, write: ["/"] } }, scope: "turn" }, params)).toThrow("exceeds");
    expect(() => encodeCodexServerResponse(protocol, permission, { permissions: { network: { enabled: true } }, scope: "session" }, { ...params, permissions: {} })).toThrow("exceeds");
  });
});
