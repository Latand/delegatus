import { createHash } from "node:crypto";

/** RPC IDs are scoped to one app-server lifetime. The generation is minted by
 * the transport owner and never taken from a replayed request's parameters. */
export interface CodexRequestIdentity {
  generation: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  method: string;
  requestId: string | number;
  approvalId: string | null;
}

export interface CodexRequestReceipt {
  identity: CodexRequestIdentity;
  receivedAt: string;
  requestDigest: string;
  protocolError?: string;
  dispatch?: { digest: string; at: string; selectionDigest?: string };
  serverResolution?: { at: string; outcome: "answered" | "server-resolved" };
  recovery?: { at: string; outcome: "delivery-uncertain" | "callback-unavailable"; reason: "timeout" | "process-lost" | "resumed-without-callback" };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}

export function codexRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function codexAnswerMatchesDispatch(receipt: CodexRequestReceipt, value: unknown): boolean {
  const digest = codexRequestDigest(value);
  return receipt.dispatch?.digest === digest || receipt.dispatch?.selectionDigest === digest;
}

export function codexRequestIdentity(generation: string, method: string, requestId: string | number, params: Record<string, unknown>): CodexRequestIdentity {
  const field = (name: string) => typeof params[name] === "string" ? params[name] as string : null;
  return { generation, method, requestId, threadId: field("threadId"), turnId: field("turnId"), itemId: field("itemId"), approvalId: field("approvalId") };
}

export function sameCodexRequest(left: CodexRequestIdentity, right: CodexRequestIdentity): boolean {
  return codexRequestDigest(left) === codexRequestDigest(right);
}

/** Durable input is checked before it can restore callback ownership. */
export function validCodexRequestReceipt(value: unknown): value is CodexRequestReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as CodexRequestReceipt;
  const identity = receipt.identity;
  const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const optionalId = (value: unknown) => value === null || typeof value === "string";
  return !!identity && typeof identity === "object"
    && typeof identity.generation === "string" && identity.generation.length > 0
    && typeof identity.method === "string" && identity.method.length > 0
    && (typeof identity.requestId === "string" || Number.isSafeInteger(identity.requestId))
    && [identity.threadId, identity.turnId, identity.itemId, identity.approvalId].every(optionalId)
    && timestamp(receipt.receivedAt) && digest(receipt.requestDigest)
    && (receipt.protocolError === undefined || typeof receipt.protocolError === "string")
    && (receipt.dispatch === undefined || !!receipt.dispatch && digest(receipt.dispatch.digest) && timestamp(receipt.dispatch.at)
      && (receipt.dispatch.selectionDigest === undefined || digest(receipt.dispatch.selectionDigest)))
    && (receipt.serverResolution === undefined || !!receipt.serverResolution && timestamp(receipt.serverResolution.at)
      && (receipt.serverResolution.outcome === "server-resolved" || receipt.serverResolution.outcome === "answered" && !!receipt.dispatch))
    && (receipt.recovery === undefined || !!receipt.recovery && timestamp(receipt.recovery.at)
      && ["delivery-uncertain", "callback-unavailable"].includes(receipt.recovery.outcome)
      && ["timeout", "process-lost", "resumed-without-callback"].includes(receipt.recovery.reason));
}
