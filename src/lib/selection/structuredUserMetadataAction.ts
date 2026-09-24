"use server";

import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";
import { readStructuredUserProvenance } from "./structuredUserMetadata";

/** Bounded keyed reads for the browser's transcript decoder. The normal
 * Viewer host/origin gate also covers this server-action entry point. */
export async function structuredUserProvenance(refs: string[]): Promise<Record<string, DeliveredMessageProvenance | null>> {
  const requestHeaders = await headers();
  if (rejectCrossOrigin(new NextRequest("http://localhost/", { headers: requestHeaders }))) {
    throw new Error("forbidden: cross-origin request");
  }
  return readStructuredUserProvenance(refs);
}
