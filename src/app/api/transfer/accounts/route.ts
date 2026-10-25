import type { NextRequest } from "next/server";

import { getAccounts, postAccounts } from "@/lib/transfer/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The accounts an import brought, with their state on this install. */
export function GET(req: NextRequest) {
  return getAccounts(req);
}

/** Verify them with a live limit read, or record «not needed here» or «this is the right account». */
export function POST(req: NextRequest) {
  return postAccounts(req);
}
