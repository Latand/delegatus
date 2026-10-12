import type { NextRequest } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { memoryProfileService } from "@/lib/memory/profileService";
import { MemoryProfileError } from "@/lib/memory/profile";
import type { Locale } from "@/lib/i18n/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };
function valid(project: unknown, locale: unknown): project is string {
  return typeof project === "string" && !!project.trim() && project.length <= 256 && (locale === "uk" || locale === "en");
}
export async function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project");
  const locale = request.nextUrl.searchParams.get("locale");
  if (!valid(project, locale)) return Response.json({}, { status: 400 });
  try { return Response.json(memoryProfileService().read(project, locale as Locale), { headers: NO_STORE }); }
  catch { return Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE }); }
}
export async function POST(request: NextRequest) {
  const rejection = rejectCrossOrigin(request); if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return Response.json({ error: authority.error }, { status: authority.status });
  let body;
  try { body = await request.json(); } catch { return Response.json({}, { status: 400 }); }
  if (!body || !valid(body.project, body.locale)) return Response.json({}, { status: 400 });
  try {
    const run = memoryProfileService().start(body.project, body.locale);
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        unsubscribe = run.subscribe(view => { if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(view)}\n`)); });
        void run.done.then(() => { if (!closed) { closed = true; unsubscribe?.(); controller.close(); } });
      },
      cancel() { closed = true; unsubscribe?.(); },
    });
    return new Response(stream, { headers: { ...NO_STORE, "Content-Type": "application/x-ndjson", "X-Accel-Buffering": "no" } });
  } catch (error) {
    return Response.json({ error: error instanceof MemoryProfileError ? error.code : "failed" }, { status: 503, headers: NO_STORE });
  }
}
