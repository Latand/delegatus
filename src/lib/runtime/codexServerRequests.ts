import type { CodexPinnedProtocol } from "@/lib/accounts/codexPinnedProtocol";
import type { ServerRequest } from "@/lib/accounts/protocol/0.162.1/types/ServerRequest";
import type { CommandExecutionRequestApprovalResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/CommandExecutionRequestApprovalResponse";
import type { FileChangeRequestApprovalResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/FileChangeRequestApprovalResponse";
import type { PermissionsRequestApprovalResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/PermissionsRequestApprovalResponse";
import type { ToolRequestUserInputResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/ToolRequestUserInputResponse";
import type { McpServerElicitationRequestResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/McpServerElicitationRequestResponse";
import type { DynamicToolCallResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/DynamicToolCallResponse";
import type { ChatgptAuthTokensRefreshResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/ChatgptAuthTokensRefreshResponse";
import type { AttestationGenerateResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/AttestationGenerateResponse";
import type { CurrentTimeReadResponse } from "@/lib/accounts/protocol/0.162.1/types/v2/CurrentTimeReadResponse";
import type { ApplyPatchApprovalResponse } from "@/lib/accounts/protocol/0.162.1/types/ApplyPatchApprovalResponse";
import type { ExecCommandApprovalResponse } from "@/lib/accounts/protocol/0.162.1/types/ExecCommandApprovalResponse";
import { isDeepStrictEqual } from "node:util";

export type CodexServerRequestMethod = ServerRequest["method"];
export type CodexServerResponses = {
  "item/commandExecution/requestApproval": CommandExecutionRequestApprovalResponse;
  "item/fileChange/requestApproval": FileChangeRequestApprovalResponse;
  "item/permissions/requestApproval": PermissionsRequestApprovalResponse;
  "item/tool/requestUserInput": ToolRequestUserInputResponse;
  "mcpServer/elicitation/request": McpServerElicitationRequestResponse;
  "item/tool/call": DynamicToolCallResponse;
  "account/chatgptAuthTokens/refresh": ChatgptAuthTokensRefreshResponse;
  "attestation/generate": AttestationGenerateResponse;
  "currentTime/read": CurrentTimeReadResponse;
  applyPatchApproval: ApplyPatchApprovalResponse;
  execCommandApproval: ExecCommandApprovalResponse;
};
export type CodexServerRequestHandler<K extends CodexServerRequestMethod> = (request: Extract<ServerRequest, { method: K }>) => CodexServerResponses[K] | Promise<CodexServerResponses[K]>;
export type CodexServerRequestHandlers = { [K in CodexServerRequestMethod]: CodexServerRequestHandler<K> };

export async function routeCodexServerRequest<K extends CodexServerRequestMethod>(
  protocol: CodexPinnedProtocol,
  request: Extract<ServerRequest, { method: K }>,
  handlers: Pick<CodexServerRequestHandlers, K>,
): Promise<CodexServerResponses[K]> {
  decodeCodexServerRequest(protocol, request.id, request.method, request.params);
  // The discriminated request and the mapped handler share the same key. This
  // local assertion restores that correlation for TypeScript's indexed access.
  const handler = handlers[request.method as K] as CodexServerRequestHandler<K>;
  const result = await handler(request);
  encodeCodexServerResponse(protocol, request.method, result, request.params);
  return result;
}

/** Exact method dispatch; unsupported methods never get raw JSON answers. */
export const codexServerRequestKinds = {
  "item/commandExecution/requestApproval": "command",
  "item/fileChange/requestApproval": "patch",
  "item/permissions/requestApproval": "permissions",
  "item/tool/requestUserInput": "question",
  "mcpServer/elicitation/request": "elicitation",
  "item/tool/call": "tool",
  "account/chatgptAuthTokens/refresh": "auth",
  "attestation/generate": "attestation",
  "currentTime/read": "time",
  applyPatchApproval: "patch",
  execCommandApproval: "command",
} as const satisfies Record<CodexServerRequestMethod, string>;

export function codexServerRequestKind(method: string): string {
  return Object.prototype.hasOwnProperty.call(codexServerRequestKinds, method)
    ? codexServerRequestKinds[method as CodexServerRequestMethod] : "protocol-unsupported";
}

export function decodeCodexServerRequest(protocol: CodexPinnedProtocol, id: string | number, method: string, params: unknown): ServerRequest {
  if (typeof id === "number" && !Number.isSafeInteger(id)) throw new Error("Codex request ID must be a safe integer");
  protocol.assertServerRequest(method, params);
  const request = { id, method, params } as ServerRequest;
  if (request.method === "item/tool/requestUserInput") {
    const ids = request.params.questions.map(question => question.id);
    if (ids.length === 0 || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) {
      throw new Error("Codex question IDs must be nonempty and unique");
    }
    if (request.params.questions.some(question => !question.question.trim())) {
      throw new Error("Codex question prompts must be nonempty");
    }
  }
  return request;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A grant may retain or remove offered entries. It cannot add a path, access
 * mode, network capability or recursion depth that the request did not offer. */
function withinRequestedScope(grant: unknown, requested: unknown): boolean {
  if (grant === null || grant === undefined || grant === false) return true;
  if (Array.isArray(grant)) return grant.every(entry => Array.isArray(requested) && requested.some(offered => isDeepStrictEqual(entry, offered)));
  if (grant && typeof grant === "object") return Object.entries(grant).every(([key, value]) => withinRequestedScope(value, object(requested)[key]));
  return isDeepStrictEqual(grant, requested);
}

export function encodeCodexServerResponse(protocol: CodexPinnedProtocol, method: string, value: unknown, params?: unknown): unknown {
  if (codexServerRequestKind(method) === "protocol-unsupported") throw new Error(`Codex server request ${method} is unsupported; raw answers are disabled`);
  protocol.assertServerResponse(method, value);
  if (params !== undefined) {
    const request = decodeCodexServerRequest(protocol, 0, method, params);
    const result = object(value);
    if (request.method === "item/commandExecution/requestApproval") {
      const offered = request.params.availableDecisions;
      const decision = result.decision;
      if (offered && !offered.some(option => isDeepStrictEqual(option, decision))) throw new Error("Codex approval decision was not offered");
      const amendment = object(decision);
      if (!offered && amendment.acceptWithExecpolicyAmendment && !isDeepStrictEqual(object(amendment.acceptWithExecpolicyAmendment).execpolicy_amendment, request.params.proposedExecpolicyAmendment)) {
        throw new Error("Codex execpolicy amendment was not offered");
      }
      if (!offered && amendment.applyNetworkPolicyAmendment && !request.params.proposedNetworkPolicyAmendments?.some(offered => isDeepStrictEqual(offered, object(amendment.applyNetworkPolicyAmendment).network_policy_amendment))) {
        throw new Error("Codex network amendment was not offered");
      }
    }
    if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
      const decision = result.decision;
      if (decision !== "approved" && decision !== "approved_for_session" && decision !== "abort" && !Object.hasOwn(object(decision), "denied")) {
        throw new Error("Codex legacy approval did not offer this policy amendment or automatic outcome");
      }
    }
    if (request.method === "item/permissions/requestApproval" && !withinRequestedScope(result.permissions, request.params.permissions)) {
      throw new Error("Codex permission grant exceeds the requested scope");
    }
    if (request.method === "item/tool/requestUserInput") {
      const answers = object(result.answers);
      const questions = request.params.questions;
      if (Object.keys(answers).length !== questions.length || questions.some(question => !Object.hasOwn(answers, question.id))) {
        throw new Error("Codex answers must name exactly the offered question IDs");
      }
      for (const question of questions) {
        const selected = object(answers[question.id]).answers as string[];
        if (question.options?.length && !question.isOther && selected.some(answer => !question.options!.some(option => option.label === answer))) {
          throw new Error("Codex question answer was not offered");
        }
      }
    }
  }
  return value;
}
