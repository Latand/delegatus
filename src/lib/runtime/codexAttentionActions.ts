/** Serializable, request-bound actions shared by the host projection and UI. */
export interface CodexAttentionAction {
  kind: "accept" | "acceptForSession" | "decline" | "cancel" | "execpolicy" | "network" | "grantTurn" | "grantSession";
  response: unknown;
  detail?: string;
}

/** Serializable display controls; native response values stay with the owner. */
export function projectCodexAttentionActions(method: string, params: Record<string, unknown>, requestDigest: string): CodexAttentionAction[] {
  return codexAttentionActions(method, params).map((action, actionIndex) => ({
    kind: action.kind,
    response: { codexResponse: { requestDigest, actionIndex } },
    ...(action.detail ? { detail: action.detail.length <= 256 ? action.detail : `${action.detail.slice(0, 256)}…` } : {}),
  }));
}

export function codexAttentionActions(method: string, params: Record<string, unknown>): CodexAttentionAction[] {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : [
      "accept", "acceptForSession", "decline", "cancel",
      ...(method === "item/commandExecution/requestApproval" && Array.isArray(params.proposedExecpolicyAmendment)
        ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } }] : []),
      ...(method === "item/commandExecution/requestApproval" && Array.isArray(params.proposedNetworkPolicyAmendments)
        ? params.proposedNetworkPolicyAmendments.map(amendment => ({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } })) : []),
    ];
    return decisions.flatMap((decision): CodexAttentionAction[] => {
      if (decision === "accept" || decision === "acceptForSession" || decision === "decline" || decision === "cancel") return [{ kind: decision, response: { decision } }];
      if (decision && typeof decision === "object") {
        if ("acceptWithExecpolicyAmendment" in decision) return [{ kind: "execpolicy", response: { decision }, detail: JSON.stringify(decision.acceptWithExecpolicyAmendment) }];
        if ("applyNetworkPolicyAmendment" in decision) return [{ kind: "network", response: { decision }, detail: JSON.stringify(decision.applyNetworkPolicyAmendment) }];
      }
      return [];
    });
  }
  if (method === "item/permissions/requestApproval" && params.permissions && typeof params.permissions === "object") {
    const permissions = Object.fromEntries(Object.entries(params.permissions).filter(([, value]) => value !== null));
    return [
      { kind: "grantTurn", response: { permissions, scope: "turn" }, detail: JSON.stringify(permissions) },
      { kind: "grantSession", response: { permissions, scope: "session" }, detail: JSON.stringify(permissions) },
      { kind: "decline", response: { permissions: {}, scope: "turn" } },
    ];
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") return [
    { kind: "accept", response: { decision: "approved" } },
    { kind: "acceptForSession", response: { decision: "approved_for_session" } },
    { kind: "decline", response: { decision: { denied: { rejection: "Declined by the operator" } } } },
    { kind: "cancel", response: { decision: "abort" } },
  ];
  if (method === "mcpServer/elicitation/request") return [
    { kind: "decline", response: { action: "decline", content: null, _meta: null } },
    { kind: "cancel", response: { action: "cancel", content: null, _meta: null } },
  ];
  return [];
}
