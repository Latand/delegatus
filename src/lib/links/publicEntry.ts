import { statePath } from "@/lib/configDir";
import { readViewerGatewayConfig, VIEWER_GATEWAY_FILE } from "@/runtime-host/deploymentProxy";
import { readViewerEntries, VIEWER_ENTRIES_FILE } from "@/runtime-host/viewerEntries";

/** The entry a reverse proxy may publish. Read the gateway on each call: its
 * trust setting can change without a Viewer restart. */
export function publicEntry(): { port: number; publishable: boolean } {
  if (process.env.LLV_DOCKER_NSENTER_SHIMS !== "1") {
    const port = Number(process.env.PORT);
    return { port: Number.isInteger(port) && port > 0 ? port : 3000, publishable: true };
  }
  const bound = readViewerEntries(statePath(VIEWER_ENTRIES_FILE));
  if (bound?.stableEntry === "pipe") return { port: bound.stablePort, publishable: true };
  const configured = Number(process.env.LLV_VIEWER_PORT);
  const stable = bound?.stablePort ?? (Number.isInteger(configured) && configured > 0 ? configured : 8898);
  const gateway = readViewerGatewayConfig(statePath(VIEWER_GATEWAY_FILE), stable);
  if (bound?.remoteEntryPort !== null && bound?.remoteEntryPort !== undefined) {
    if (gateway.config.localEntry === "trusted" && gateway.config.remoteEntryPort === null) {
      return { port: stable, publishable: false };
    }
    return { port: bound.remoteEntryPort, publishable: true };
  }
  if (bound) return { port: stable, publishable: gateway.problem !== null || gateway.config.localEntry !== "trusted" };
  if (!bound && gateway.config.remoteEntryPort !== null) return { port: gateway.config.remoteEntryPort, publishable: true };
  return { port: stable, publishable: gateway.problem !== null || gateway.config.localEntry !== "trusted" };
}
