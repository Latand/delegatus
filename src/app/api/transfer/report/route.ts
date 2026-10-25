import type { NextRequest } from "next/server";

import { getReport } from "@/lib/transfer/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The verification report of the last import, or of the one named. */
export function GET(req: NextRequest) {
  return getReport(req);
}
