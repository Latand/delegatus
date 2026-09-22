import { getEvents } from "@/lib/selfUpdate/routes";

/* The Snapshot as server-sent events (#2007). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return getEvents(request);
}
