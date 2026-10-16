import type { NextRequest } from "next/server";

import { auditKeyAction, keysJson, keysOwnerGate, readBoundedJson } from "@/lib/keys/access";
import { IMPORT_TEXT_LIMIT, isKeyId, type ImportConfirmation } from "@/lib/keys/shared";
import { applyImport, previewImport } from "@/lib/keys/store";
import { isStagingMode } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function confirmation(raw: unknown): ImportConfirmation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const confirm: ImportConfirmation = {};
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isKeyId(id) || !entry || typeof entry !== "object") return null;
    const { kind, was } = entry as { kind?: unknown; was?: unknown };
    if (kind !== "new" && kind !== "replaces") return null;
    if (was !== undefined && was !== null && typeof was !== "string") return null;
    confirm[id] = { kind, was: typeof was === "string" ? was : null };
  }
  return confirm;
}

/**
 * «Import keys» (design §7): `{ text }` answers the preview, masked, and
 * writes nothing; `{ text, confirm }` writes the keys the operator confirmed
 * from that preview, each only while it still matches what was shown.
 */
export async function POST(req: NextRequest) {
  const refusal = keysOwnerGate(req);
  if (refusal) return refusal;
  const body = await readBoundedJson(req, IMPORT_TEXT_LIMIT + 4096);
  if (!body || typeof body.text !== "string" || body.text.length > IMPORT_TEXT_LIMIT) {
    return keysJson({ error: "paste at most 64 KiB of NAME=value lines", code: "invalid_import" }, 400);
  }
  if (body.confirm === undefined) return keysJson(previewImport(body.text));
  if (isStagingMode()) return keysJson({ error: "a staging release shares production's keys", code: "staging" }, 409);
  const confirm = confirmation(body.confirm);
  if (!confirm) return keysJson({ error: "unreadable confirmation", code: "invalid_import" }, 400);
  const outcome = await applyImport(body.text, confirm);
  auditKeyAction("import", outcome.saved);
  return keysJson(outcome);
}
