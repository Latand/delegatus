import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { NextRequest, type NextResponse } from "next/server";

import { executeSpawnRequest, productionSpawnCommandDependencies, spawnSuggestions } from "@/lib/agent/spawnCommand";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function workspaceGET(req: NextRequest) {
  return spawnSuggestions(req);
}

const workspacePOST = Object.assign(
  async (req: NextRequest): Promise<NextResponse<SpawnResponse | ApiError>> => await executeSpawnRequest(req),
  {
    withDependencies: executeSpawnRequest,
    productionDependencies: productionSpawnCommandDependencies,
  },
);

export const GET = workspaceRoute("/api/spawn", workspaceGET);

export const POST = workspaceRoute("/api/spawn", workspacePOST);
