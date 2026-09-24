import type { NextRequest } from "next/server";

import { postRestart } from "@/lib/selfUpdate/routes";

/* Asks the launcher to restart one process of a checkout install (#2007).
   Operator only. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return postRestart(request);
}
