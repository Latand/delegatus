import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { statePath } from "@/lib/configDir";

/** Read-only: report a linked earlier install only when it owns active state.
 * An explicit isolated state root must never inherit the notice from the home.
 */
export function usesLinkedLegacyState(
  root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  activeState = statePath(),
): boolean {
  try {
    const preferred = path.join(root, "delegatus");
    const legacy = path.join(root, "agent-log-viewer");
    return fs.lstatSync(preferred).isSymbolicLink()
      && fs.realpathSync(preferred) === fs.realpathSync(legacy)
      && fs.realpathSync(activeState) === fs.realpathSync(path.join(legacy, "state"));
  } catch {
    return false;
  }
}
