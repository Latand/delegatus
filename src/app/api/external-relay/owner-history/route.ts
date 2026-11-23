import { NextRequest, NextResponse } from "next/server";
import { guardOwnerHistoryRoute } from "@/lib/externalRelay/routeGuard";
import { readOwnerHistory } from "@/lib/externalRelay/ownerHistory";
import { fetchOwnerMedia, ownerMediaInputSchema } from "@/lib/externalRelay/ownerMedia";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { z } from "zod";

const requestSchema = z.union([z.object({ op: z.enum(["groups", "messages"]), chat: z.string().optional(), from: z.string().optional(),
  to: z.string().optional(), cursor: z.string().max(400).optional(), limit: z.number().int().optional() }).strict(),
  ownerMediaInputSchema.omit({ action: true }).extend({ op: z.literal("media") })]);
export async function POST(request: NextRequest) {
  const refused = guardOwnerHistoryRoute(request);
  if (refused) { refused.headers.set("Cache-Control", "no-store"); return refused; }
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "invalid_arguments" }, { status: 400, headers: { "Cache-Control": "no-store" } }); }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_arguments" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const { op, ...args } = parsed.data;
  const result = op === "media" ? await fetchOwnerMedia({ action: op, ...args }, callerConversationId(request) ?? "operator")
    : await readOwnerHistory({ action: op, ...args });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
