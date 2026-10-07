import type { NextRequest } from "next/server";
import { reviewGET, reviewPOST } from "@/lib/prototypeReview/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest,context: Context) { return reviewGET(request,(await context.params).id); }
export async function POST(request: NextRequest,context: Context) { return reviewPOST(request,(await context.params).id); }
