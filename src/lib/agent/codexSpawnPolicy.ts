import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Reviewed features that do not create agent threads. Everything else reported
 * by a denied launch's interpreter is disabled, including future features. */
export const CODEX_SINGLE_AGENT_FEATURES: ReadonlySet<string> = new Set([
  "code_mode", "code_mode_host", "code_mode_only", "compaction_image_budget",
  "computer_use", "content_item_kinds", "enable_request_compression", "fast_mode", "goals",
  "hooks", "image_generation", "mentions_v2", "network_proxy",
  "prevent_idle_sleep", "realtime_conversation", "secret_auth_storage",
  "shell_snapshot", "shell_tool", "skill_mcp_dependency_install", "skill_search",
  "sleep_tool", "system_proxy_fallback", "tool_call_mcp_elicitation",
  "unbounded_connection_retries", "unified_exec", "unified_exec_tty",
  "view_image", "workspace_dependencies", "write_stdin_approval",
]);

export interface CodexFeature {
  name: string;
  stage: string;
  enabled: boolean;
}

export function parseCodexFeatures(output: string): CodexFeature[] {
  const features: CodexFeature[] = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9_.]*)\s+(stable|experimental|under development|deprecated|removed)\s+(true|false)$/.exec(line.trim());
    if (!match || features.some((feature) => feature.name === match[1])) {
      throw new Error("Codex features could not be enumerated safely; sub-agent policy refuses this launch");
    }
    features.push({ name: match[1], stage: match[2], enabled: match[3] === "true" });
  }
  if (!features.some((feature) => feature.name === "multi_agent")) {
    throw new Error("Codex features could not be enumerated safely; sub-agent policy refuses this launch");
  }
  return features;
}

type FeatureReader = (binary: string, env: NodeJS.ProcessEnv) => CodexFeature[];
let testReader: FeatureReader | undefined;

/** Same explicit dependency seam used by the launch shell-policy tests. */
export function setCodexFeatureReaderForTest(reader: FeatureReader): () => void {
  if (process.env.NODE_ENV !== "test") throw new Error("Codex feature test reader is unavailable");
  const previous = testReader;
  testReader = reader;
  return () => { testReader = previous; };
}

/** Read the exact launch binary, without account configuration, auth or a turn.
 * No cache: replacing the interpreter must also replace its feature inventory. */
export function readCodexFeatures(binary: string, source: NodeJS.ProcessEnv = process.env): CodexFeature[] {
  if (testReader) return testReader(binary, source);
  // The Docker shim resolves the interpreter under HOME in the host mount
  // namespace. Its probe files must live on that shared mount as well.
  const hostShim = source.LLV_DOCKER_NSENTER_SHIMS === "1";
  const sharedHome = source.HOME ?? os.homedir();
  const base = hostShim ? path.join(sharedHome, ".cache", "delegatus", "codex-feature-probes") : os.tmpdir();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = fs.mkdtempSync(path.join(base, "delegatus-codex-features-"));
  try {
    const home = path.join(root, "home");
    const codexHome = path.join(home, ".codex");
    const temporary = path.join(root, "tmp");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(temporary);
    const result = spawnSync(binary, ["features", "list"], {
      cwd: hostShim ? sharedHome : root,
      env: { ...source, HOME: hostShim ? sharedHome : home, USERPROFILE: home, CODEX_HOME: codexHome,
        XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "cache"),
        TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error("Codex features could not be enumerated safely; sub-agent policy refuses this launch");
    }
    return parseCodexFeatures(result.stdout);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** Removed flags have no runtime effect. Grants for plugins remain separate. */
export function codexDeniedFeatures(features: readonly CodexFeature[]): string[] {
  return [...new Set(["multi_agent", "multi_agent_v2", ...features
    .filter((feature) => feature.stage !== "removed" && !CODEX_SINGLE_AGENT_FEATURES.has(feature.name))
    .map((feature) => feature.name)])];
}

export function codexSubagentArgs(binary: string, allowSubagents = false, env: NodeJS.ProcessEnv = process.env, terminal = false): string[] {
  const features = !allowSubagents || terminal ? readCodexFeatures(binary, env) : [];
  const isolation = terminal && features.some((feature) => feature.name === "daemon_auto_start") ? ["--no-daemon"] : [];
  if (allowSubagents) return [...isolation, "-c", "agents.enabled=true"];
  // Older supported interpreters reject --disable for a feature they do not
  // know. Their reported inventory still determines every emitted CLI flag.
  const reported = new Set(features.map((feature) => feature.name));
  return [...isolation, "-c", "agents.enabled=false", "-c", 'approvals_reviewer="user"', ...codexDeniedFeatures(features).filter((name) => reported.has(name))
    .flatMap((feature) => ["--disable", feature])];
}

export function codexSubagentConfig(features: readonly CodexFeature[], allowSubagents: boolean): Record<string, boolean> {
  return allowSubagents ? { multi_agent: true } : Object.fromEntries(codexDeniedFeatures(features).map((name) => [name, false]));
}
