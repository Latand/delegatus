import { memoryIndex } from "@/lib/memory/service";
import { offerForHook } from "@/lib/memory/controller";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 128000) {
      try { memoryIndex().recordInjectionActivity("skipped"); } catch { /* optional ledger */ }
      return Response.json({ block: "" });
    }
    return Response.json({ block: await offerForHook(request, JSON.parse(raw)) });
  } catch {
    try { memoryIndex().recordInjectionActivity("failed"); } catch { /* optional ledger */ }
    return Response.json({ block: "" });
  }
}
