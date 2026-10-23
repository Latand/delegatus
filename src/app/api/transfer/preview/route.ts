import type { NextRequest } from "next/server";

import { postPreview } from "@/lib/transfer/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The dry run of an import: stages the bundle and writes nothing else. */
export function POST(req: NextRequest) {
  return postPreview(req);
}
