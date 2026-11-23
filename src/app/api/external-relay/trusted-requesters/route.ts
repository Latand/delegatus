import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { applyRequesterOperation, previewRequesterProposal, trustedRequesterView } from "@/lib/externalRelay/requesterEnrolment";
import { requesterOperation, requesterProposalId } from "@/lib/externalRelay/requesterEnrolmentContract";
import { requesterBrowserAuthority } from "@/lib/externalRelay/requesterEnrolmentHttp";
import { readRelayStore } from "@/lib/externalRelay/store";
import { guardRelayRoute, refusedHere, relayRouteError } from "@/lib/externalRelay/routeGuard";

const noStore = { headers: { "Cache-Control": "no-store" } };
const commandSchema = z.union([
  z.strictObject({ confirmed: z.literal(true), proposalId: requesterProposalId }),
  z.strictObject({ confirmed: z.literal(true), operation: requesterOperation, revision: z.number().int().nonnegative(),
    project: z.string().max(256).nullable() }),
]);

export async function GET(req: NextRequest) {
  const refusal = guardRelayRoute(req);
  if (refusal) return refusal;
  const authorize = requesterBrowserAuthority(req);
  try {
    authorize(readRelayStore());
    const query = req.nextUrl.searchParams;
    const proposal = query.get("proposal");
    if (proposal !== null) {
      const id = requesterProposalId.safeParse(proposal);
      return id.success ? NextResponse.json(previewRequesterProposal(id.data, authorize), noStore) : refusedHere();
    }
    const relay = query.get("relay");
    const target = query.get("target");
    if (!relay || !target || relay.length > 128 || target.length > 128) return refusedHere();
    return NextResponse.json(await trustedRequesterView({ relay, target }, authorize, { includeHistory: query.get("history") !== "0" }), noStore);
  } catch (error) { return relayRouteError(error); }
}

export async function POST(req: NextRequest) {
  const refusal = guardRelayRoute(req);
  if (refusal) return refusal;
  const authorize = requesterBrowserAuthority(req);
  try {
    authorize(readRelayStore());
    const input = commandSchema.safeParse(await req.json());
    if (!input.success) return refusedHere();
    return NextResponse.json(await applyRequesterOperation(input.data, authorize), noStore);
  } catch (error) { return relayRouteError(error); }
}
