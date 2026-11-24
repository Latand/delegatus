import { performanceSpans, type RegistryReadCaller } from "@/lib/performanceSpans";
import { requestWorkload, type RegistryReadSite } from "@/lib/requestWorkload";
import { viewerLoopMonitor, withViewerOperation } from "@/lib/viewerLoopMonitor";

// Collect above the measuring wrappers so a minified bundle still shows its caller.
function registryCallerStack(): string | undefined {
  const trace: { stack?: string } = {};
  Error.captureStackTrace(trace, measureRegistryRead);
  return trace.stack;
}

/** Capture the outer caller before the read establishes its registry operation. */
export function measureRegistryRead<T>(site: RegistryReadSite, work: () => T, trackOperation = false): T {
  const operation = viewerLoopMonitor.current(site === "registry.keyed" ? "active" : undefined);
  requestWorkload.registryRead(site, operation);
  const caller: RegistryReadCaller | undefined = site === "registry.keyed" ? { operation } : undefined;
  const measure = () => performanceSpans.sync(site, work, 0, 0, caller);
  try {
    return trackOperation ? withViewerOperation("registry.read", measure) : measure();
  } finally {
    // Bun can elide tail-call frames. Capture here, when this boundary is still
    // on the stack and the inner measurement and operation wrappers have returned.
    caller?.sample?.(registryCallerStack);
  }
}
