import { NextRequest, NextResponse } from "next/server";

import { antigravityAccountSection } from "@/lib/accounts/antigravityAccountSection";
import { probeAntigravityAuth } from "@/lib/accounts/antigravityAuthProbe";
import { engineCliPresence } from "@/lib/accounts/engineConnection";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The recorded Antigravity state. Reads the record and the cached command probe; starts no `agy`. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(antigravityAccountSection(await engineCliPresence("antigravity")));
}

/** "Check sign-in": a real ACP session start against `agy`, then the state it recorded. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { action?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (body.action !== "probe") return NextResponse.json({ error: "action must be probe" }, { status: 400 });
  const probed = await probeAntigravityAuth();
  /* The probe just looked at the command itself; drop the one-minute cache so the next read agrees. */
  await engineCliPresence("antigravity", { fresh: true });
  return NextResponse.json({ ...antigravityAccountSection(probed.cli), probe: { inconclusive: probed.inconclusive === true } });
}
