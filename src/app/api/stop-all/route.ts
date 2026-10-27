import type { NextRequest } from "next/server";

import { postStopAll } from "@/lib/stopAll";

/* The app menu's «Stop Delegatus»: starts `delegatus stop --all` for this
   install (src/lib/stopAll.ts). Operator only. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest) {
  return postStopAll(request);
}
