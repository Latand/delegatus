/* The Update surface's routes (#2007). They live here, where their tests
   import them: a route module may export only the documented route fields.

   Every mutating route asks what the Viewer's other operator-only routes ask
   (the setup guide's health check, designation): the request must be
   same-origin (`rejectCrossOrigin`, the perimeter) and must not come from an
   agent (`requireOperatorAuthority` refuses any caller presenting the
   conversation capability the registry issued it). An update or a restart is
   the operator's alone. */
import { NextResponse, type NextRequest } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { selfUpdateService, snapshotStream } from "./instance";
import type { ActionResult } from "./service";
import { CHECKOUT_STEPS, type CheckoutStepName } from "./types";

function operatorGate(request: NextRequest): NextResponse | null {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const operator = requireOperatorAuthority(request);
  return operator.ok ? null : NextResponse.json({ error: operator.error }, { status: operator.status });
}

const noStore = { "cache-control": "no-store" };

async function answer(result: ActionResult): Promise<NextResponse> {
  const snapshot = await selfUpdateService().snapshot();
  return result.ok
    ? NextResponse.json(snapshot, { status: 202, headers: noStore })
    : NextResponse.json({ error: result.error, snapshot }, { status: result.status, headers: noStore });
}

async function body(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json() as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function getSnapshot(): Promise<NextResponse> {
  const service = selfUpdateService();
  service.ensureChecked();
  return NextResponse.json(await service.snapshot(), { headers: noStore });
}

export function getEvents(request: Request): Response {
  const service = selfUpdateService();
  service.ensureChecked();
  return new Response(snapshotStream(service, request.signal), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

export async function postCheck(request: NextRequest): Promise<NextResponse> {
  const refused = operatorGate(request);
  if (refused) return refused;
  const service = selfUpdateService();
  const snapshot = await service.snapshot();
  if (snapshot.mode === "unsupported") return answer({ ok: false, status: 409, error: "This install cannot check for updates" });
  if (snapshot.busy === "update") return answer({ ok: false, status: 409, error: "An update is running" });
  void service.check();
  return answer({ ok: true });
}

/** `{ key, retry? }`: `key` is the browser's id for this one press, so a
    repeated POST of the same press is the same deployment. */
export async function postUpdate(request: NextRequest): Promise<NextResponse> {
  const refused = operatorGate(request);
  if (refused) return refused;
  const input = await body(request);
  const key = typeof input.key === "string" ? input.key : "";
  if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) return NextResponse.json({ error: "key must be 1–64 letters, digits or dashes" }, { status: 400 });
  const service = selfUpdateService();
  return answer(input.retry === true ? await service.retry(key) : await service.startUpdate(key));
}

/** `{ role: "web" | "runtime-host", confirm }`. The runtime host drops the
    agents it supervises, so its restart carries the surface's confirmation. */
export async function postRestart(request: NextRequest): Promise<NextResponse> {
  const refused = operatorGate(request);
  if (refused) return refused;
  const input = await body(request);
  if (input.role !== "web" && input.role !== "runtime-host") {
    return NextResponse.json({ error: "role must be web or runtime-host" }, { status: 400 });
  }
  if (input.role === "runtime-host" && input.confirm !== true) {
    return NextResponse.json({ error: "Restarting the runtime host needs {\"confirm\":true}" }, { status: 400 });
  }
  return answer(await selfUpdateService().restart(input.role));
}

export function getStepLog(step: string): Response {
  if (!(CHECKOUT_STEPS as readonly string[]).includes(step)) return new Response("Unknown step\n", { status: 404 });
  const text = selfUpdateService().stepLog(step as CheckoutStepName);
  return new Response(text ?? "", { headers: { "content-type": "text/plain; charset=utf-8", ...noStore } });
}
