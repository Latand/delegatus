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
  // The discriminated request and the mapped handler share the same key. This
  // local assertion restores that correlation for TypeScript's indexed access.
  const handler = handlers[request.method as K] as CodexServerRequestHandler<K>;
  const result = await handler(request);
  protocol.assertServerResponse(request.method, result);
  return result;
}

/** Exact method dispatch; unsupported methods never get raw JSON answers. The
 * follow-up will bind these codecs to durable replay and delivery receipts. */
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

export function encodeCodexServerResponse(protocol: CodexPinnedProtocol, method: string, value: unknown): unknown {
  if (codexServerRequestKind(method) === "protocol-unsupported") throw new Error(`Codex server request ${method} is unsupported; raw answers are disabled`);
  protocol.assertServerResponse(method, value);
  return value;
}
