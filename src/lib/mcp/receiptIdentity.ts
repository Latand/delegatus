import { createHash } from "node:crypto";

import type { McpToolArgs, McpToolName } from "./server";

/** Scope is hashed so a receipt key carries no caller identity. */
export function receiptKey(toolName: McpToolName, requestId: string, scope: string | null): string {
  return scope === null ? `${toolName}:${requestId}`
    : `${toolName}@${createHash("sha256").update(scope).digest("hex").slice(0, 32)}:${requestId}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

export function requestDigest(toolName: McpToolName, args: McpToolArgs): string {
  return createHash("sha256").update(JSON.stringify(stable({ toolName, args }))).digest("hex");
}
