import type { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { openRouterKeySource, writeOpenRouterApiKey } from "@/lib/asks/settings";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isStagingMode } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
function answer(status = 200, error?: string) {
  const source = openRouterKeySource();
  return Response.json({ present: source !== null, source, ...(isStagingMode() ? { staging: true } : {}), ...(error ? { error } : {}) }, { status, headers });
}
export async function GET() { return answer(); }
export async function PUT(request: NextRequest) {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return answer(authority.status, "operator_only");
  if (isStagingMode()) return answer(409, "staging");
  if (openRouterKeySource() === "env") return answer(409, "environment_authoritative");
  // Bound the secret in memory; no error includes the submitted body.
  const reader = request.body?.getReader();
  if (!reader) return answer(400, "invalid_key");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return answer(400, "invalid_key"); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) return answer(400, "invalid_key");
    return writeOpenRouterApiKey(key) ? answer() : answer(500, "write_failed");
  } catch { return answer(400, "invalid_key"); }
  finally { reader.releaseLock(); }
}
