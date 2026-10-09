import type { NextRequest } from "next/server";
import { publishPOST } from "@/lib/prototypeReview/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) { return publishPOST(request); }
