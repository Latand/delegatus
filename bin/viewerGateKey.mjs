import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appDirIn } from "./appDir.mjs";

/**
 * What a Viewer's boot does with the remembered phone-access choice (#2024),
 * readable from outside the Viewer. `restorePhoneAccessGate` gates a booting
 * Viewer on the key file whenever the flag is present and its environment
 * sets no key, so whoever has to authenticate against a Viewer it did not
 * hand a key to (the launcher's self-update probes, the deploy adapter's
 * health probes, the staging deploy, the runtime host's trusted local entry)
 * resolves the key here, from the same files.
 *
 * Plain ESM with node builtins only, so the launcher (`bin/cli.mjs`) and the
 * TypeScript sources share one definition.
 */

/**
 * Any entry at the flag's path counts as set: a flag that is empty, not
 * `tailscale`, or unreadable may still stand for a live mapping, and reading
 * it as off would serve that mapping ungated.
 *
 * @param {string} flagPath
 * @returns {boolean}
 */
export function phoneAccessFlagMayBeSet(flagPath) {
  try {
    lstatSync(flagPath);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

/* The launcher's key shape (`bin/tailscale.mjs`); a key file that does not
   hold one is replaced at boot, so it is no key yet. */
const KEY_PATTERN = /^[0-9a-f]{32}$/;

function configRoot(environment) {
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  if (xdg) return xdg;
  const home = environment.HOME?.trim();
  return home ? join(home, ".config") : null;
}

/**
 * The key a Viewer started with `environment` asks every request for, or null
 * when it gates on nothing: the key the environment sets, else, while the
 * phone-access flag or a links gate is present, the key file beside the flag.
 * The key file is read when this is called, so a caller that probes a booted
 * Viewer sees the key that boot minted.
 *
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @returns {string | null}
 */
export function viewerBootGateKey(environment) {
  if (environment.LLV_TOKEN) return environment.LLV_TOKEN;
  const root = configRoot(environment);
  if (!root) return null;
  const directory = appDirIn(root);
  const state = environment.LLV_STATE_DIR || join(directory, "state");
  let linked = false;
  const selfPath = join(state, "links/self.json");
  try {
    const self = JSON.parse(readFileSync(selfPath, "utf8"));
    if (self.publicUrl) linked = !["localhost", "127.0.0.1", "::1"].includes(new URL(self.publicUrl).hostname.replace(/^\[|\]$/g, ""));
  } catch { linked = phoneAccessFlagMayBeSet(selfPath); }
  if (!linked) linked = phoneAccessFlagMayBeSet(join(state, "links/grants.json"));
  if (!linked && !phoneAccessFlagMayBeSet(join(directory, "phone-access"))) return null;
  try {
    const key = readFileSync(join(directory, "token"), "utf8").trim();
    return KEY_PATTERN.test(key) ? key : null;
  } catch {
    return null;
  }
}
