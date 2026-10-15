import { after } from "next/server";
import { GET as filesResponse } from "./operatorProjection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export { HEAD } from "./operatorProjection";

export function GET(request: Request): Promise<Response> {
  return filesResponse(request, after);
}
