import fs from "node:fs";
import path from "node:path";

import { appDirIn } from "../../../bin/appDir.mjs";

/**
 * What a Viewer's boot does with the remembered phone-access choice (#2024),
 * readable from outside the Viewer. `restorePhoneAccessGate` gates a booting
 * Viewer on the key file whenever the flag is present and its environment
 * sets no key, so whoever has to authenticate against a release it did not
 * start (the deploy adapter's health probes, the staging deploy, the runtime
 * host's trusted local entry) resolves the key here, from the same files.
 */

/** Any entry at the flag's path counts as set: a flag that is empty, not
    `tailscale`, or unreadable may still stand for a live mapping, and reading
    it as off would serve that mapping ungated. */
export function phoneAccessFlagMayBeSet(flagPath: string): boolean {
  try {
    fs.lstatSync(flagPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/* The launcher's key shape (`bin/tailscale.mjs`); a key file that does not
   hold one is replaced at boot, so it is no key yet. */
const KEY_PATTERN = /^[0-9a-f]{32}$/;

function configRoot(environment: Readonly<Record<string, string | undefined>>): string | null {
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  if (xdg) return xdg;
  const home = environment.HOME?.trim();
  return home ? path.join(home, ".config") : null;
}

/**
 * The key a Viewer started with `environment` asks every request for, or null
 * when it gates on nothing: the key the environment sets, else, while the
 * phone-access flag is present, the key file beside it. The key file is read
 * when this is called, so a caller that probes a booted Viewer sees the key
 * that boot minted.
 */
export function viewerBootGateKey(environment: Readonly<Record<string, string | undefined>>): string | null {
  if (environment.LLV_TOKEN) return environment.LLV_TOKEN;
  const root = configRoot(environment);
  if (!root) return null;
  const directory = appDirIn(root);
  if (!phoneAccessFlagMayBeSet(path.join(directory, "phone-access"))) return null;
  try {
    const key = fs.readFileSync(path.join(directory, "token"), "utf8").trim();
    return KEY_PATTERN.test(key) ? key : null;
  } catch {
    return null;
  }
}
