import type { NextRequest } from "next/server";
import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { keysJson, keysOwnerGate, keysOwnerRequest, readBoundedJson } from "@/lib/keys/access";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isStagingMode } from "@/lib/staging";
import { PlanError } from "@/lib/chatgptPlan/errors";
import { configuredClientId } from "@/lib/chatgptPlan/constants";
import { chatgptPlan } from "@/lib/chatgptPlan/session";
import { LIVE_BACKEND_MODEL } from "@/lib/voiceCompanion/sessionConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const localBrowser = (req: NextRequest) =>
  /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.get("host") ?? "");

function writeGate(req: NextRequest) {
  return keysOwnerGate(req) ?? (isStagingMode() ? keysJson({ state: "off_staging" }, 409)
    : !localBrowser(req) ? keysJson({ state: "remote_browser" }, 409) : null);
}

export async function GET(req: NextRequest) {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const browser = () => !req.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER) && operatorBrowserRequest(req);
  if (!browser()) return keysJson({ code: "operator_only" }, 403);
  const owner = keysOwnerRequest(req);
  const status = await chatgptPlan().status(LIVE_BACKEND_MODEL, owner, localBrowser(req));
  if (!browser()) return keysJson({ code: "operator_only" }, 403);
  return keysJson(owner && keysOwnerRequest(req) ? status : { state: status.state });
}

function failure(error: unknown) {
  const reason = error instanceof PlanError ? error.reason : "retry_later";
  return keysJson({ reason }, reason === "busy" ? 409 : reason === "invalid_request" ? 400 : 503);
}

export async function POST(req: NextRequest) {
  const refusal = writeGate(req);
  if (refusal) return refusal;
  const body = await readBoundedJson(req, 1_024);
  const recheck = writeGate(req);
  if (recheck) return recheck;
  if (!body || !((Object.keys(body).length === 1) || (body.action === "replace-registration" && Object.keys(body).length === 2))) return keysJson({ reason: "invalid_request" }, 400);
  const session = chatgptPlan();
  const guard = () => !writeGate(req);
  try {
    switch (body.action) {
      case "sign-in": case "enable-plan": {
        const authorizeUrl = await session.start(body.action === "enable-plan", guard);
        const denied = writeGate(req);
        if (denied) return denied;
        return keysJson({ authorizeUrl });
      }
      case "cancel":
        session.oauth.cancel();
        return keysJson({ ok: true });
      case "replace-registration":
        await session.replaceRejectedRegistration(typeof body.clientId === "string" ? body.clientId : configuredClientId() ?? "", guard);
        return writeGate(req) ?? keysJson({ ok: true });
      case "acknowledge":
        await session.acknowledge(guard);
        return writeGate(req) ?? keysJson({ ok: true });
      default: return keysJson({ reason: "invalid_request" }, 400);
    }
  } catch (error) { return failure(error); }
}

export async function DELETE(req: NextRequest) {
  const refusal = writeGate(req);
  if (refusal) return refusal;
  try {
    const revocationConfirmed = await chatgptPlan().signOut(() => !writeGate(req));
    return writeGate(req) ?? keysJson({ revocationConfirmed });
  } catch (error) { return failure(error); }
}
