import type { NextRequest } from "next/server";
import { keysJson, keysOwnerGate, readBoundedJson } from "@/lib/keys/access";
import { chooseService, isServiceFeature, ServiceChoiceError, servicesView } from "@/lib/openaiServices/policy";
import { isStagingMode } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const refusal = keysOwnerGate(req);
  return refusal ?? keysJson(servicesView());
}
export async function PUT(req: NextRequest) {
  const refusal = keysOwnerGate(req);
  if (refusal) return refusal;
  if (isStagingMode()) return keysJson({ error: "settings are shared with production", code: "staging" }, 409);
  const body = await readBoundedJson(req, 1024);
  if (!body || !isServiceFeature(body.feature) || typeof body.provider !== "string" || Object.keys(body).some(key => key !== "feature" && key !== "provider")) {
    return keysJson({ error: "invalid feature or provider", code: "invalid_provider" }, 400);
  }
  try { await chooseService(body.feature, body.provider); }
  catch (error) {
    if (error instanceof ServiceChoiceError) return keysJson({ error: error.code, code: error.code }, error.code === "invalid_provider" ? 400 : 409);
    return keysJson({ error: "the choice could not be saved", code: "write_failed" }, 500);
  }
  return keysJson(servicesView());
}
