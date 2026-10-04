import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { hasLocalPipelineController } from "./controllerSignal";

export const PIPELINE_REMOTE_ACTIONS = ["skip-stage", "retry-stage", "takeover"] as const;

/** A separate MCP process must read what the serving Viewer implements.
 * A legacy, stale or dead controller never authorizes a deferred action. */
export function servingControllerSupports(action: string): boolean {
  if (hasLocalPipelineController()) return true;
  try {
    const heartbeat = JSON.parse(fs.readFileSync(statePath("flow-pipeline-controller-heartbeat.json"), "utf8"));
    const age = Date.now() - Date.parse(heartbeat.updatedAt);
    return heartbeat.schemaVersion === 1 && age >= 0 && age < 120_000
      && Number.isSafeInteger(heartbeat.pid) && heartbeat.pid > 0
      && typeof heartbeat.processIdentity === "string"
      && procBackend.processIdentity(heartbeat.pid) === heartbeat.processIdentity
      && Array.isArray(heartbeat.remoteActions) && heartbeat.remoteActions.includes(action);
  } catch { return false; }
}
