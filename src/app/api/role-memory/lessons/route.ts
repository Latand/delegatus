import { NextRequest } from "next/server";
import { stageLessons } from "@/lib/memory/roleStore";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* What each stage attempt of a project left, for the line under its report on the card. */
export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");
  if (!project || project.length > 256) return Response.json({}, { status: 400 });
  try { return Response.json({ lessons: stageLessons(project) }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ lessons: [], error: "unavailable" }, { status: 503 }); }
}
