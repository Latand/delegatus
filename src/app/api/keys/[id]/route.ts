import type { NextRequest } from "next/server";

import { auditKeyAction, keysJson, keysOwnerGate, readBoundedJson } from "@/lib/keys/access";
import { isKeyId, type KeysAnswer } from "@/lib/keys/shared";
import { keyEntries, writeKey } from "@/lib/keys/store";
import { isStagingMode } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** «Replace» and «Add» on a key's row: `{ value }`, written by the key's own writer; the answer is the masked list. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const refusal = keysOwnerGate(req);
  if (refusal) return refusal;
  const { id } = await ctx.params;
  if (!isKeyId(id)) return keysJson({ error: "no such key", code: "not_found" }, 404);
  if (isStagingMode()) return keysJson({ error: "a staging release shares production's keys", code: "staging" }, 409);
  const body = await readBoundedJson(req, 8192);
  if (!body || typeof body.value !== "string") return keysJson({ error: "invalid key", code: "invalid_key" }, 400);
  const outcome = await writeKey(id, body.value);
  if (outcome === "invalid") return keysJson({ error: "invalid key", code: "invalid_key" }, 400);
  if (outcome === "env") return keysJson({ error: "the key is set by its variable; change it there", code: "set_by_env" }, 409);
  if (outcome === "telegram_refused") return keysJson({ error: "Telegram did not accept the bot token", code: "telegram_refused" }, 409);
  if (outcome === "failed") return keysJson({ error: "the key could not be saved", code: "write_failed" }, 500);
  auditKeyAction("replace", [id]);
  return keysJson<KeysAnswer>({ keys: keyEntries(true), staging: false, owner: true });
}
