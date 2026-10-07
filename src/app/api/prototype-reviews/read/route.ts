import type { NextRequest } from "next/server";
import { reviewReadPOST } from "@/lib/prototypeReview/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) { return reviewReadPOST(request); }
