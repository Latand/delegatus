import type { NextRequest } from "next/server";

import { handleMcpHttpRequest, mcpHttpMethodNotAllowed } from "@/lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Viewer MCP tool surface over Streamable HTTP (`src/lib/mcp/http.ts`). */
export function POST(request: NextRequest): Promise<Response> {
  return handleMcpHttpRequest(request);
}

export function GET(): Response {
  return mcpHttpMethodNotAllowed();
}

export function DELETE(): Response {
  return mcpHttpMethodNotAllowed();
}
