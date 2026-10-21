import fs from "node:fs";
import path from "node:path";

/** Keep the mandatory Viewer registration on this checkout and inside the
 * fixture's own state. The stable installed launcher belongs to the operator. */
export function registerSignalFixtureMcp(config: string): void {
  const root = path.dirname(config);
  fs.writeFileSync(path.join(config, ".claude.json"), JSON.stringify({
    hasCompletedOnboarding: true,
    mcpServers: { viewer: {
      type: "stdio", command: process.execPath, args: [path.resolve("src/lib/mcp/entry.ts")],
      env: { NODE_ENV: "test", HOME: root, TMPDIR: root,
        XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
        LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
    } },
  }), { mode: 0o600 });
}
