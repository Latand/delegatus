import { NextRequest, NextResponse } from "next/server";

import { flowPipelineController } from "@/lib/pipelines/controller";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PipelineTick = () => Promise<void>;

async function post(request: NextRequest, tick: PipelineTick): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  try {
    await tick();
  } catch {
    // The controller owns the diagnostic; each HTTP waiter gets a bounded
    // response without asking Next to print the same rejection again.
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}

export const POST = Object.assign(
  (request: NextRequest) => post(request, () => flowPipelineController().tick("remote-signal")),
  { withDependencies: (request: NextRequest, tick: PipelineTick) => post(request, tick) },
);
