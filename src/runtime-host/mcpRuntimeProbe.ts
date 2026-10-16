import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { MCP_HEALTH_PROBE_CAPABILITY_ENV } from "@/lib/mcp/healthProbeAdmission";
import { candidateDeclaredTools, MCP_DEPLOYMENT_CONTRACT } from "@/lib/mcp/toolCatalog";
import { redactMonitorText } from "@/lib/monitor/redact";
import type {
  ViewerMcpRuntimeCallFailure,
  ViewerMcpRuntimeHealthEvidence,
  ViewerMcpRuntimeIdentity,
} from "@/lib/runtime/contracts";

import { probeExcerpt } from "./deploymentHealth";
import { McpProbeStdioTransport } from "./mcpProbeStdioTransport";
import type { McpHealthProbeAdmissionConsumer } from "./mcpHealthProbeAdmissionChannel";

export interface McpRuntimeProbeOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  runtime: ViewerMcpRuntimeIdentity;
  healthProbeCapability?: string;
  healthProbeAdmissions?: McpHealthProbeAdmissionConsumer;
  timeoutMs?: number;
  /** Absolute warmup budget for the required catalog read, never renewed by
      another incomplete generation. The usual request timeout still applies. */
  readinessTimeoutMs?: number;
  onProcessReady?: (pid: number) => void;
}

function successfulToolCall(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as { isError?: unknown; structuredContent?: unknown };
  if (result.isError === true || !result.structuredContent || typeof result.structuredContent !== "object") return false;
  return (result.structuredContent as { ok?: unknown }).ok === true;
}

/** What the candidate's own MCP said when a read was refused. `deploymentStatus
    false` with nothing beside it cost a whole deploy cycle to interpret in
    #790, and the refusal already carries the status and the reason. */
export function mcpToolCallRefusal(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "no result";
  const result = value as { structuredContent?: unknown; content?: unknown };
  const structured = result.structuredContent && typeof result.structuredContent === "object"
    ? (result.structuredContent as { error?: unknown; status?: unknown })
    : null;
  const error = typeof structured?.error === "string" ? structured.error : null;
  const text = Array.isArray(result.content)
    ? (result.content as Array<{ type?: unknown; text?: unknown }>)
      .find((entry) => entry?.type === "text" && typeof entry.text === "string")?.text as string | undefined
    : undefined;
  const reason = error ?? text ?? "refused without a reason";
  /* The refusal usually spells the status out already; a second copy of it
     reads like two different failures. */
  const status = typeof structured?.status === "number" && !reason.includes(String(structured.status))
    ? ` (status ${structured.status})`
    : "";
  return `${reason}${status}`;
}

/** The MCP failure envelope's own code (`tool_failed`, `tool_not_permitted`,
    `call_interrupted`, …), which classes a refusal without parsing its prose. */
export function mcpToolCallRefusalCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object") return null;
  const code = (structured as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim().slice(0, 64) : null;
}

function catalogRetryDelay(value: unknown): number | null {
  if (mcpToolCallRefusalCode(value) !== "scan_incomplete") return null;
  const result = value as { structuredContent?: { retryable?: unknown; details?: { retryAfterSeconds?: unknown } } };
  const failure = result.structuredContent;
  if (failure?.retryable !== true) return null;
  const seconds = failure.details?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.max(50, Math.ceil(seconds * 1_000)) : 1_000;
}

/* How much of a refusal the durable record keeps. The record outlives the
   candidate and the operator pastes it into issues, so the text is redacted,
   collapsed to one printable line and clamped where it is captured, exactly
   like `containerLog`. Redaction runs before the clamp so a truncation can
   never leave half of what it removed. */
const CALL_FAILURE_CHARS = 300;

function recordedRefusal(value: unknown): string {
  return probeExcerpt(redactMonitorText(mcpToolCallRefusal(value)), CALL_FAILURE_CHARS);
}

/** The failing reads, each with the tool's own account of why it failed.
    `calls` already says WHICH read failed, and that boolean was the entire
    record for three deploys — it can explain none of them (#790). Empty when
    every read answered. */
export function mcpProbeCallFailures(
  calls: Array<{ name: string; ok: boolean; result: unknown }>,
): ViewerMcpRuntimeCallFailure[] {
  return calls
    .filter((call) => !call.ok)
    .map((call) => {
      const code = mcpToolCallRefusalCode(call.result);
      return {
        tool: call.name,
        ...(code ? { code } : {}),
        error: recordedRefusal(call.result),
      };
    });
}

/** Names the failed read, its refusal and the control surface the probe was
    pointed at, so a failure can be told apart from a probe aimed at the wrong
    Viewer without re-reading the adapter (#790). */
export function mcpProbeFailureDetail(input: {
  controlUrl: string | undefined;
  calls: Array<{ name: string; ok: boolean; result: unknown }>;
}): string {
  const failures = mcpProbeCallFailures(input.calls)
    .map((failure) => `${failure.tool}: ${failure.error}`);
  const target = input.controlUrl ? ` against ${input.controlUrl}` : "";
  return `MCP runtime read probes failed${target} - ${failures.join("; ") || "no read reported a reason"}`
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
}

export const VIEWER_CONTROL_URL_ENV = "LLV_VIEWER_CONTROL_URL";

/** The control endpoint the probed runtime must read through. Absent or blank,
    the MCP server falls back to the fixed loopback address, which belongs to the
    Viewer that is already serving — so the probe would grade the running
    generation and pass or fail it on behalf of the runtime under test (#790).
    Callers get the trimmed endpoint back, or `null` to refuse on. */
export function probeControlUrl(value: string | undefined): string | null {
  const url = value?.trim() ?? "";
  return /^https?:\/\/[^\s]+$/.test(url) ? url : null;
}

export async function probeMcpRuntime(options: McpRuntimeProbeOptions): Promise<ViewerMcpRuntimeHealthEvidence> {
  const checkedAt = new Date().toISOString();
  const timeout = Math.max(1, options.timeoutMs ?? 15_000);
  const controlUrl = probeControlUrl(options.env[VIEWER_CONTROL_URL_ENV]);
  /* Refusing before anything is spawned: a probe that cannot name its own
     target must never address another one instead. */
  if (!controlUrl) {
    return {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady: false,
      tools: [],
      calls: { deploymentStatus: false, boardSnapshot: false },
      ok: false,
      detail: `MCP runtime probe requires ${VIEWER_CONTROL_URL_ENV}: without the probed runtime's own control endpoint`
        + " its reads resolve to the Viewer already serving instead of the one under test",
    };
  }
  const environment = { ...options.env };
  delete environment[MCP_HEALTH_PROBE_CAPABILITY_ENV];
  if (options.healthProbeCapability) {
    environment[MCP_HEALTH_PROBE_CAPABILITY_ENV] = options.healthProbeCapability;
  }
  const transport = new McpProbeStdioTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: environment,
    ...(options.healthProbeAdmissions ? { healthAdmissions: options.healthProbeAdmissions } : {}),
  });
  const client = new Client({ name: "viewer-deployment-mcp-probe", version: "1.0.0" });
  let processReady = false;
  let tools: string[] = [];
  let deploymentStatus = false;
  let boardSnapshot = false;
  let evidence: ViewerMcpRuntimeHealthEvidence;
  try {
    await client.connect(transport, { timeout });
    processReady = true;
    if (transport.pid !== null) options.onProcessReady?.(transport.pid);
    const listed = await client.listTools(undefined, { timeout });
    tools = listed.tools.map((tool) => tool.name).sort();
    const declared = candidateDeclaredTools(client.getServerCapabilities()?.experimental, tools);
    const missingContract = MCP_DEPLOYMENT_CONTRACT.filter((tool) => !tools.includes(tool));
    const missingDeclared = declared.filter((tool) => !tools.includes(tool));
    if (missingContract.length || missingDeclared.length) {
      const cause = missingContract.length
        ? `MCP candidate is missing deployment contract tools: ${missingContract.join(", ")}`
        : `MCP candidate did not register declared tools: ${missingDeclared.join(", ")}`;
      throw new Error(`${cause}. Retrying the same image will not help; choose a corrected release.`);
    }
    const requestId = randomUUID();
    const deployment = await client.callTool({
      name: "deployment_status",
      arguments: { clientRequestId: `deployment-probe-${requestId}`, limit: 1 },
    }, undefined, { timeout });
    deploymentStatus = successfulToolCall(deployment);
    const configuredReadiness = options.readinessTimeoutMs;
    const readinessBudget = typeof configuredReadiness === "number" && Number.isFinite(configuredReadiness)
      ? Math.min(60_000, Math.max(1, configuredReadiness)) : 60_000;
    const readinessDeadline = performance.now() + readinessBudget;
    let board: unknown;
    let boardAttempt = 0;
    while (true) {
      try {
        board = await client.callTool({
          name: "board_snapshot",
          // Read receipts can retain a refusal. Each readiness observation asks
          // again in this same process under its own read id.
          arguments: { clientRequestId: `board-probe-${requestId}-${boardAttempt++}`, limit: 1 },
        }, undefined, { timeout: Math.min(timeout, Math.max(1, readinessDeadline - performance.now())) });
      } catch (error) {
        // Preserve the last catalog refusal when the last remaining slice
        // expires. A transport failure within the budget remains a failure.
        if (board && catalogRetryDelay(board) !== null && performance.now() >= readinessDeadline
          && error instanceof Error && "code" in error && error.code === ErrorCode.RequestTimeout) break;
        throw error;
      }
      if (performance.now() > readinessDeadline) {
        if (successfulToolCall(board)) {
          board = { structuredContent: { ok: false, code: "catalog_readiness_timeout", error: "catalog read completed after its readiness deadline" } };
        }
        break;
      }
      if (successfulToolCall(board) || !deploymentStatus) break;
      const delay = catalogRetryDelay(board);
      const remaining = readinessDeadline - performance.now();
      if (delay === null || remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
      if (performance.now() >= readinessDeadline) break;
    }
    boardSnapshot = successfulToolCall(board);
    const ok = deploymentStatus && boardSnapshot;
    const reads = [
      { name: "deployment_status", ok: deploymentStatus, result: deployment },
      { name: "board_snapshot", ok: boardSnapshot, result: board },
    ];
    /* A refused read's own account survives after the candidate is retired. */
    const callFailures = mcpProbeCallFailures(reads);
    evidence = {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady,
      tools,
      calls: { deploymentStatus, boardSnapshot },
      ...(callFailures.length ? { callFailures } : {}),
      ok,
      ...(ok ? {} : {
        detail: mcpProbeFailureDetail({ controlUrl, calls: reads }),
      }),
    };
  } catch (error) {
    evidence = {
      checkedAt,
      revision: options.runtime.revision,
      artifactDigest: options.runtime.artifactDigest,
      processReady,
      tools,
      calls: { deploymentStatus, boardSnapshot },
      ok: false,
      detail: (error instanceof Error ? error.message : "MCP runtime probe failed").replace(/[\r\n]+/g, " ").slice(0, 500),
    };
  } finally {
    await transport.close();
  }
  if (transport.cleanupError) {
    evidence.ok = false;
    evidence.detail = probeExcerpt(redactMonitorText(
      `MCP probe cleanup failed: ${transport.cleanupError.message}; ${evidence.detail ?? ""}`,
    ), 500);
  }
  return evidence;
}
