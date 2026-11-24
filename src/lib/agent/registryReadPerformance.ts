import { performanceSpans } from "@/lib/performanceSpans";
import { requestWorkload, type RegistryReadSite } from "@/lib/requestWorkload";
import { viewerLoopMonitor, withViewerOperation } from "@/lib/viewerLoopMonitor";

/** Capture the outer caller before the read establishes its registry operation. */
export function measureRegistryRead<T>(site: RegistryReadSite, work: () => T, trackOperation = false): T {
  requestWorkload.registryRead(site, viewerLoopMonitor.current());
  const operation = site === "registry.keyed" ? viewerLoopMonitor.current("active") : undefined;
  const measure = () => performanceSpans.sync(site, work, 0, 0, operation);
  return trackOperation ? withViewerOperation("registry.read", measure) : measure();
}
