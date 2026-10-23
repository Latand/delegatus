import type { NextRequest } from "next/server";

import { postApply } from "@/lib/transfer/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Apply a previewed bundle; refused when this install changed since the preview. */
export function POST(req: NextRequest) {
  return postApply(req);
}
