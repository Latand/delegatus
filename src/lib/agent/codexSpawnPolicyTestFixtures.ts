import { parseCodexFeatures, setCodexFeatureReaderForTest } from "./codexSpawnPolicy";

/** Shared inventory for fake launchers, including separately started fixtures. */
export function beginCodexFeatureFixture(): () => void {
  return setCodexFeatureReaderForTest(() => parseCodexFeatures([
    "multi_agent stable true",
    "multi_agent_v2 stable true",
    "daemon_auto_start stable true",
    "memories under development true",
    "plugins stable true",
    "shell_tool stable true",
    "future_worker experimental true",
  ].join("\n")));
}
