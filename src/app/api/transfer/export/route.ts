import type { NextRequest } from "next/server";

import { postExport } from "@/lib/transfer/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `delegatus export` and the owner's page: this install's memory and settings as a plain bundle. */
export function POST(req: NextRequest) {
  return postExport(req);
}
