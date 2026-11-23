import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { appConnectPOST } from "@/lib/forge/appConnectHttp";
import type { NextRequest } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = workspaceRoute("/api/forge/app-connect", (request: NextRequest) => appConnectPOST(request));
