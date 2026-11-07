import { POST as spawnPOST } from "../route";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A guarded launch never falls back to a release without this receiver. */
export async function POST(request: NextRequest) {
  return spawnPOST(request);
}
