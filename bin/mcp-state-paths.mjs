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
  const explicitStateDirectory = env.LLV_STATE_DIR?.trim();
  let stateDirectory = explicitStateDirectory || path.join(appDirIn(configRoot), "state");
  const isSpawnSandboxPath = value => typeof value === "string"
    && value.split(/[\\/]/).includes("llv-spawn-sandbox");
  // A sandboxed config root supplies the default state only when the caller
  // did not explicitly select one. An explicit state inside the sandbox still
  // needs recovery, while an isolated explicit state stays authoritative.
  const sandboxed = isSpawnSandboxPath(explicitStateDirectory)
    || (!explicitStateDirectory && isSpawnSandboxPath(configRoot));
  const hostState = env.LLV_STRUCTURED_HOST?.trim();
  if (sandboxed && hostState) {
    stateDirectory = hostState;
    configRoot = configRootForState(hostState) || configRoot;
  }
  return { configRoot, stateDirectory };
}
