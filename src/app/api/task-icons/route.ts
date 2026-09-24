import { NextRequest, NextResponse } from "next/server";

import { taskIconNodes, type TaskIconNode } from "@/lib/tasks/taskIconNodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The drawings of the task icons a page shows (#2102):
 * `GET /api/task-icons?names=bug,rocket` answers
 * `{ icons: { bug: [...], rocket: [...] } }`, and null for a name lucide does
 * not have. An icon's drawing changes only with the lucide-react version, so
 * the browser keeps the answer for a day.
 */
export async function GET(req: NextRequest): Promise<NextResponse<{ icons: Record<string, TaskIconNode | null> }>> {
  const names = (req.nextUrl.searchParams.get("names") ?? "").split(",");
  return NextResponse.json({ icons: await taskIconNodes(names) }, { headers: { "cache-control": "private, max-age=86400" } });
}
