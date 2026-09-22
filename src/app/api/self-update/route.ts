import { getSnapshot } from "@/lib/selfUpdate/routes";

/* The Update surface's Snapshot (#2007). Handlers live in
   `@/lib/selfUpdate/routes`, where their tests import them. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return getSnapshot();
}
