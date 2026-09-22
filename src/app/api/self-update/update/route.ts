import type { NextRequest } from "next/server";

import { postUpdate } from "@/lib/selfUpdate/routes";

/* Starts or retries an update (#2007): a staged build in a checkout install,
   a Viewer deployment in a managed one. Operator only. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return postUpdate(request);
}
