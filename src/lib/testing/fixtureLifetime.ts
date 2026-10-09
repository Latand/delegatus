import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";

/** Bind a fixture to the recorded runner even if it dies before module loading.
 * The launch environment carries the start identity, so PID reuse cannot keep
 * a fixture alive. The fallback binds to its immediate parent at first import.
 * Windows uses the kernel creation FILETIME through the existing proc backend.
 */
if (!process.env.LLV_FIXTURE_PARENT_IDENTITY && process.ppid <= 1) process.exit(86);
const parent = process.env.LLV_FIXTURE_PARENT_IDENTITY
  ? JSON.parse(process.env.LLV_FIXTURE_PARENT_IDENTITY)
  : captureProcessIdentity(Number(process.env.LLV_FIXTURE_PARENT_PID) || process.ppid);
if (!parent.startIdentity || !parent.bootEpoch) throw new Error("fixture parent has no verifiable start identity");
export const checkFixtureParent = () => {
  if (processIdentityStatus(parent) !== "alive" || procBackend.processExited(parent.pid)) process.exit(86);
};
checkFixtureParent();
setInterval(checkFixtureParent, 100).unref();
