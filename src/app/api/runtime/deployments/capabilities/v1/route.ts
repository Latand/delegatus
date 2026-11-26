import { sqliteModeFromEnvironment } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import {
  structuredDeliveryControllerReadiness,
  structuredStartupStatus,
} from "@/lib/runtime/startupStatus";
import { HOT_STATE_BACKEND, readHotStateAuthority, readHotStateReleaseTarget } from "@/lib/state/hotStateAuthority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function viewerReleaseStartupState(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { activationReady: boolean; releaseReady: boolean; servesTraffic: boolean } {
  const directory = env.LLV_STATE_DIR?.trim() || statePath(".");
  const target = readHotStateReleaseTarget(directory, env);
  if (!target) return { activationReady: true, releaseReady: true, servesTraffic: true };
  const port = env.PORT?.trim();
  const servesTraffic = !port || new URL(target.endpoint).port === port;
  if (target.hotStateBackend !== HOT_STATE_BACKEND) {
    return { activationReady: true, releaseReady: true, servesTraffic };
  }
  if (!servesTraffic) return { activationReady: true, releaseReady: true, servesTraffic: false };
  const authority = readHotStateAuthority(directory);
  const ownsActivatedState = authority?.mode === "sqlite"
    && authority.releaseRevision === target.revision
    && typeof authority.activationReadyAt === "string";
  return {
    activationReady: ownsActivatedState,
    releaseReady: ownsActivatedState && typeof authority.releaseReadyAt === "string",
    servesTraffic: true,
  };
}

/* The deployment readiness gate probes this route with a 5s budget. It reads
   two small handoff records and still avoids instantiating the agent registry,
   whose first probe would otherwise pay a multi-MB parse. The activation gate
   remains compatible with the deployed predecessor adapter. Its serving
   verifier reads releaseReady, so that existing signal also covers structured
   startup. Passive candidates retain their pre-promotion health semantics. */
export function GET(): Response {
  const startup = viewerReleaseStartupState();
  if (!startup.activationReady) {
    return Response.json(
      { error: "Viewer hot-state activation is incomplete" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const structuredHostStartup = structuredStartupStatus();
  const structuredDeliveryController = structuredDeliveryControllerReadiness();
  const releaseReady = startup.releaseReady && (!startup.servesTraffic
    || ((structuredHostStartup === null || structuredHostStartup.state === "ready")
      && structuredDeliveryController !== "unavailable"));
  // Admission uses the durable deployment owner. Promotion still requires
  // releaseReady, which includes serving-time adoption and delivery readiness.
  return Response.json(
    {
      capability: "viewer-deployments",
      version: 1,
      admissionFence: true,
      registryBackendMode: sqliteModeFromEnvironment(),
      releaseReady,
      structuredDeliveryController,
      structuredHostStartup,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
