import { waitForStateLock } from "@/lib/state/lockWait";
import { NextRequest, NextResponse } from "next/server";

import {
  MAX_AGENT_NESTING_DEPTH,
  MIN_AGENT_NESTING_DEPTH,
  loadSpawnNestingPolicy,
  saveSpawnNestingPolicy,
  validMaxAgentNestingDepth,
  type SpawnNestingPolicy,
} from "@/lib/agent/nestingPolicy";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

import { isAgentInitiatedSpawn } from "../admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<SpawnNestingPolicy>> {
  return NextResponse.json(await waitForStateLock("spawn.policy.read", loadSpawnNestingPolicy));
}

/** Operator-only ceiling change (#393): the agent lane can never raise its
    own nesting ceiling, so any non-same-origin caller is rejected outright. */
export async function PATCH(req: NextRequest): Promise<NextResponse<SpawnNestingPolicy | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  if (isAgentInitiatedSpawn(req)) {
    return NextResponse.json({ error: "spawn nesting policy changes require an operator session" }, { status: 403 });
  }
  let body: { maxAgentNestingDepth?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!validMaxAgentNestingDepth(body.maxAgentNestingDepth)) {
    return NextResponse.json({
      error: `maxAgentNestingDepth must be an integer between ${MIN_AGENT_NESTING_DEPTH} and ${MAX_AGENT_NESTING_DEPTH}`,
    }, { status: 400 });
  }
  const depth = body.maxAgentNestingDepth;
  return await waitForStateLock("spawn.policy.write", () => {
    saveSpawnNestingPolicy({ maxAgentNestingDepth: depth });
    return NextResponse.json(loadSpawnNestingPolicy());
  });
}
