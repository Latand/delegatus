import { NextResponse, type NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { keysOwnerGate } from "@/lib/keys/access";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { MAX_BUNDLE_BYTES } from "./bundle";
import { applyBundle, exportBundle, importReport, previewBundle } from "./service";
import type { TransferImportRequest } from "./types";
import type { TransferWorkerResponse } from "./workerProtocol";

/* The transfer routes (docs/design/install-memory-transfer.md §4.1, §4.3)
   admit exactly two callers: the host's own controller credential, which the
   CLI mints from the state directory the way the deploy client does, and the
   owner's browser page through the Keys gate. An agent, a service other than
   the controller and a member who is not the owner are refused. */

const NO_STORE = { "Cache-Control": "no-store" };

export function transferJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function transferGate(req: NextRequest): NextResponse | null {
  const perimeter = rejectCrossOrigin(req);
  if (perimeter) return perimeter;
  if (!req.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) {
    const service = internalServiceClaim(req, { readOnly: true });
    if (service.claim === "valid" && service.service === "controller") return null;
    if (service.claim !== "absent") return transferJson({ error: "the transfer is the operator's own action", code: "operator_only" }, 403);
  }
  return keysOwnerGate(req);
}

const statusOf = (response: TransferWorkerResponse) => {
  if (response.ok) return 200;
  switch (response.error.code) {
    case "target_changed": case "busy": return 409;
    case "not_staged": case "unknown_import": return 404;
    case "worker_stopped": case "failed": return 500;
    default: return 422;
  }
};

/** A body read with a bound, so an oversized upload never sits in memory. */
async function readBounded(req: NextRequest, limit: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.values(value).every(item => typeof item === "string") ? value as Record<string, string> : undefined;
}

export async function postExport(req: NextRequest): Promise<Response> {
  const refused = transferGate(req);
  if (refused) return refused;
  const body = await readBounded(req, 64 * 1024);
  let input: Record<string, unknown> = {};
  try { input = body?.length ? JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown> : {}; } catch { return transferJson({ error: "the body is not JSON", code: "bad_request" }, 400); }
  const { response, bytes } = await exportBundle(stringList(input.sections));
  if (!response.ok || !bytes) return transferJson(response, statusOf(response));
  return new Response(new Uint8Array(bytes), {
    headers: { ...NO_STORE, "content-type": "application/octet-stream", "x-delegatus-transfer": JSON.stringify(response.result) },
  });
}

/** The bundle is the body; mappings and «take the source's» choices ride in one JSON header. */
export async function postPreview(req: NextRequest): Promise<Response> {
  const refused = transferGate(req);
  if (refused) return refused;
  let options: Record<string, unknown> = {};
  try { options = JSON.parse(req.headers.get("x-delegatus-transfer-options") ?? "{}") as Record<string, unknown>; }
  catch { return transferJson({ error: "the options header is not JSON", code: "bad_request" }, 400); }
  const bytes = await readBounded(req, MAX_BUNDLE_BYTES);
  if (!bytes) return transferJson({ error: "the bundle is larger than 1 GiB", code: "too_large" }, 413);
  const response = await previewBundle(bytes, { mappings: stringMap(options.mappings), replace: stringList(options.replace) });
  return transferJson(response, statusOf(response));
}

export async function postApply(req: NextRequest): Promise<Response> {
  const refused = transferGate(req);
  if (refused) return refused;
  const body = await readBounded(req, 1024 * 1024);
  let input: Record<string, unknown>;
  try { input = JSON.parse(Buffer.from(body ?? new Uint8Array()).toString("utf8")) as Record<string, unknown>; }
  catch { return transferJson({ error: "the body is not JSON", code: "bad_request" }, 400); }
  const revisions = stringMap(input.revisions);
  if (typeof input.bundleSha256 !== "string" || !revisions) return transferJson({ error: "bundleSha256 and revisions are required", code: "bad_request" }, 400);
  const request: TransferImportRequest = { bundleSha256: input.bundleSha256, revisions, mappings: stringMap(input.mappings), replace: stringList(input.replace) };
  const response = await applyBundle(request);
  return transferJson(response, statusOf(response));
}

export async function getReport(req: NextRequest): Promise<Response> {
  const refused = transferGate(req);
  if (refused) return refused;
  const importId = req.nextUrl.searchParams.get("importId") ?? undefined;
  const response = await importReport(importId);
  return transferJson(response, statusOf(response));
}
