import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { pipelineRecordReader } from "./store";
import type { Pipeline } from "./types";

/** One token per in-flight operation, released with its timer. Always check
 * independent authorities (flows and receipts), even without a row write. */
export function pipelineRecordRevalidator(
  id: string,
  check: (current: Pipeline | null) => void,
  checkExternal?: () => void,
): () => void {
  const reader = pipelineRecordReader(id);
  let observed: string | undefined;
  const revalidate = () => {
    const version = reader.version();
    if (version !== observed) {
      check(reader.read());
      // A refused read/predicate must be retried, never remembered as valid.
      observed = version;
    }
    checkExternal?.();
  };
  return () => withViewerOperation("pipelines.revalidate", revalidate);
}
