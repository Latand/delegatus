import type { NextRequest } from "next/server";

import { postCheck } from "@/lib/selfUpdate/routes";

/* Starts an update check (#2007). Operator only. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return postCheck(request);
}
