import { transcriptSearchPage } from "@/lib/search/transcriptSearchPage";
export type { TranscriptSearchRow } from "@/lib/search/transcriptSearchPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return transcriptSearchPage(request);
}
