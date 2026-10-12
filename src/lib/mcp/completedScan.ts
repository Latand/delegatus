import { completedFileScan } from "@/lib/scanner/scanCache";
import { FILE_SCAN_RETRY_SECONDS, isFileScanIncompleteError } from "@/lib/scanner/incompleteScan";
import { McpUnadmittedRefusal } from "./server";

/** A cold catalog has no authority to resolve an unknown project or target. */
export async function completedScanForMcp(options?: Parameters<typeof completedFileScan>[0]): ReturnType<typeof completedFileScan> {
  try {
    // Targeted reads already bound their catalog wait with a signal and use
    // their descriptor-pinned fallback when that budget expires.
    return await completedFileScan({ ...options, wait: options?.signal != null });
  } catch (error) {
    if (!isFileScanIncompleteError(error)) throw error;
    throw new McpUnadmittedRefusal(`still scanning, retry in ${FILE_SCAN_RETRY_SECONDS} s`, {
      code: "scan_incomplete", status: 503, retryable: true, retryAfterSeconds: FILE_SCAN_RETRY_SECONDS,
    });
  }
}
