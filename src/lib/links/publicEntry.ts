import { statePath } from "@/lib/configDir";
import { readViewerGatewayConfig, VIEWER_GATEWAY_FILE } from "@/runtime-host/deploymentProxy";
import { readViewerEntries, VIEWER_ENTRIES_FILE } from "@/runtime-host/viewerEntries";

/** The entry a reverse proxy may publish, and whether this install has a local
 * entry that vouches for loopback callers (the only way a proxied request can
 * arrive as the operator). Read the gateway on each call: its trust setting can
 * change without a Viewer restart. */
export function publicEntry(): { port: number; publishable: boolean; localVouches: boolean } {
  if (process.env.LLV_DOCKER_NSENTER_SHIMS !== "1") {
    // Outside Docker nothing sits in front of the Viewer: with the access key
    // on, every connection authenticates itself, loopback included.
    const port = Number(process.env.PORT);
    return { port: Number.isInteger(port) && port > 0 ? port : 3000, publishable: true, localVouches: false };
  }
  const bound = readViewerEntries(statePath(VIEWER_ENTRIES_FILE));
  if (bound?.stableEntry === "pipe") return { port: bound.stablePort, publishable: true, localVouches: false };
  const configured = Number(process.env.LLV_VIEWER_PORT);
  const stable = bound?.stablePort ?? (Number.isInteger(configured) && configured > 0 ? configured : 8898);
  const gateway = readViewerGatewayConfig(statePath(VIEWER_GATEWAY_FILE), stable);
  // A gateway file with a problem is read as the default, authenticated entry.
  const localVouches = gateway.problem === null && gateway.config.localEntry === "trusted";
  if (bound?.remoteEntryPort !== null && bound?.remoteEntryPort !== undefined) {
    if (gateway.config.localEntry === "trusted" && gateway.config.remoteEntryPort === null) {
      return { port: stable, publishable: false, localVouches };
    }
    return { port: bound.remoteEntryPort, publishable: true, localVouches };
  }
  if (bound) return { port: stable, publishable: gateway.problem !== null || gateway.config.localEntry !== "trusted", localVouches };
  if (!bound && gateway.config.remoteEntryPort !== null) return { port: gateway.config.remoteEntryPort, publishable: true, localVouches };
  return { port: stable, publishable: gateway.problem !== null || gateway.config.localEntry !== "trusted", localVouches };
}
