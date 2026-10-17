import type { NextRequest } from "next/server";

import { auditKeyAction, keysJson, keysOwnerGate, readBoundedJson } from "@/lib/keys/access";
import { isKeyId } from "@/lib/keys/shared";
import { readKey } from "@/lib/keys/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One key's value, for one press of the eye or of copy (design §5). A POST,
 * so no prefetch, link or logged GET carries it; `purpose` names which press
 * it was for the log line, which never holds the value.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const refusal = keysOwnerGate(req);
  if (refusal) return refusal;
  const { id } = await ctx.params;
  if (!isKeyId(id)) return keysJson({ error: "no such key", code: "not_found" }, 404);
  const body = await readBoundedJson(req, 256);
  const purpose = body?.purpose === "copy" ? "copy" : "reveal";
  const { value } = readKey(id);
  if (!value) return keysJson({ error: "the key is not set", code: "not_set" }, 404);
  auditKeyAction(purpose, [id]);
  return keysJson({ value });
}
