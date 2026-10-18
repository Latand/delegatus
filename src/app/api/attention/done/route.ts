import type { NextRequest } from "next/server";

import { productionDoneWorld } from "@/lib/done/world";

import { doneAcknowledgeHandler, doneReadHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const read = doneReadHandler({ world: productionDoneWorld, now: Date.now, deferProjection: true });
const acknowledge = doneAcknowledgeHandler({ now: Date.now });

export function GET(): Promise<Response> {
  return read();
}

export function POST(request: NextRequest): Promise<Response> {
  return acknowledge(request);
}
