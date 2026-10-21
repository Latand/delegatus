import path from "node:path";

import { APP_DIR_NAMES, appDirIn } from "./appDir.mjs";

function configRootForState(stateDirectory) {
  const state = path.resolve(stateDirectory);
  const appDirectory = path.dirname(state);
  if (path.basename(state) !== "state" || !APP_DIR_NAMES.includes(path.basename(appDirectory))) return null;
  return path.dirname(appDirectory);
}

/** Resolve the MCP server's install context, recovering both state and config
 * from the structured-host stamp when an agent's ambient paths are sandboxed. */
export function viewerMcpStateContext(env, defaultConfigRoot) {
  let configRoot = env.XDG_CONFIG_HOME?.trim() || defaultConfigRoot;
  let stateDirectory = env.LLV_STATE_DIR?.trim() || path.join(appDirIn(configRoot), "state");
  const sandboxed = [env.LLV_STATE_DIR, configRoot].some(value =>
    typeof value === "string" && value.split(/[\\/]/).includes("llv-spawn-sandbox"));
  const hostState = env.LLV_STRUCTURED_HOST?.trim();
  if (sandboxed && hostState) {
    stateDirectory = hostState;
    configRoot = configRootForState(hostState) || configRoot;
  }
  return { configRoot, stateDirectory };
}
