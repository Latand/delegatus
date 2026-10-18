import { withViewerOperation, type ViewerOperation } from "@/lib/viewerLoopMonitor";

/** The monitor accepts labels at runtime. Keep activity's labels here while
 * the monitor's central declaration is owned by another lane. */
export const activityOperation = <T>(label: "activity.usage-backfill" | "activity.tokens.read" | "activity.time.read", work: () => T): T =>
  withViewerOperation(label as ViewerOperation, work);
