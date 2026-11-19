import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { controlEvidenceStore } from "./controlEvidence";

export const MCP_OUTER_REQUEST_HEADER = "x-delegatus-mcp-http-id";

type ToolEvent = {
  id: string;
  phase: "tool" | "claim" | "dispatch" | "settled" | "result";
  code?: string;
  fields?: string;
  at: number;
};

const scopeKey = Symbol.for("llv.mcp.outerHttpObservation");
const holder = globalThis as typeof globalThis & {
  [scopeKey]?: AsyncLocalStorage<string>;
};
const scope = () => holder[scopeKey] ??= new AsyncLocalStorage<string>();
const sockets = new WeakMap<IncomingMessage["socket"], string>();
const uuidPattern = /^[a-f0-9-]{36}$/;
const socketCodes = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ERR_STREAM_PREMATURE_CLOSE"]);
let nextWarning = 0;
let toolEventSink = persistOuterMcpToolEvent;

function warnEvidenceUnavailable(): void {
  if (Date.now() < nextWarning) return;
  nextWarning = Date.now() + 60_000;
  console.error("[mcp-http-outer] evidence unavailable; request history may be incomplete");
}

export async function prepareOuterMcpEvidence(): Promise<void> {
  try { await controlEvidenceStore("outer").ready(); }
  catch { warnEvidenceUnavailable(); }
}

function event([id, phase, read, written, code, fields]: Parameters<ReturnType<typeof controlEvidenceStore>["event"]>, at = Date.now()): void {
  try { void controlEvidenceStore("outer").event(id, phase, read, written, code, fields, at).catch(warnEvidenceUnavailable); }
  catch { warnEvidenceUnavailable(); }
}

export function currentOuterMcpRequestId(): string | undefined {
  return scope().getStore();
}

/** The listener owns the id. A header, a JSON-RPC id and a logical receipt
 * key can all be reused by callers, so none of them identifies this POST. */
export function observeOuterMcpRequest<T>(request: IncomingMessage, response: ServerResponse, dispatch: () => T): T {
  const id = randomUUID();
  const socket = request.socket;
  let connection = sockets.get(socket);
  if (!connection) { connection = randomUUID(); sockets.set(socket, connection); }
  response.setHeader(MCP_OUTER_REQUEST_HEADER, id);
  const bytes = () => [socket.bytesRead, socket.bytesWritten] as const;
  event([id, "start", ...bytes(), undefined, connection]);
  let recordedError = false;
  const onError = (error: NodeJS.ErrnoException) => {
    if (recordedError) return;
    recordedError = true;
    event([id, "error", ...bytes(), error.code && socketCodes.has(error.code) ? error.code : "socket_error"]);
  };
  request.once("error", onError);
  response.once("error", onError);
  socket.on("error", onError);
  response.once("finish", () => event([id, "response", ...bytes(), `http_${response.statusCode}`]));
  response.once("close", () => {
    socket.removeListener("error", onError);
    event([id, "close", ...bytes(), response.writableFinished ? "finished" : "premature"]);
  });
  return scope().run(id, dispatch);
}

/** Executor events use its existing private pipe, so a second process never
 * contends for the diagnostic database. These fields contain only fixed labels
 * and digests. No transport frame or response body is retained here. */
export function persistOuterMcpToolEvent(value: ToolEvent): void {
  if (!value || !uuidPattern.test(value.id) || !Number.isSafeInteger(value.at)
    || !["tool", "claim", "dispatch", "settled", "result"].includes(value.phase)
    || (value.fields !== undefined && !/^[a-z_]{1,64}(?::(?:-|[a-f0-9]{64})){3}$/.test(value.fields))) return;
  event([value.id, value.phase, 0, 0, value.code, value.fields], value.at);
}

export function recordOuterMcpExecutor(id: string | undefined): void {
  if (id) event([id, "executor"]);
}

export function setOuterMcpToolEventSink(sink: (value: ToolEvent) => void): void {
  toolEventSink = sink;
}

export function outerMcpToolEvent(id: string | undefined, phase: ToolEvent["phase"], code?: string, fields?: string): void {
  if (id) toolEventSink({ id, phase, code, fields, at: Date.now() });
}

export function outerMcpKeyDigest(tool: string, key: string | null): string | null {
  return key === null ? null : createHash("sha256").update(JSON.stringify([tool, key])).digest("hex");
}
