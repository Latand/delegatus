/* Flags and environment → Config. Pure apart from path resolution. */
import { join, resolve } from "node:path";
import { assertIsolatedRoot } from "./env";

/* The production Viewer and its dev server: a managed install may never take them. */
export const RESERVED_PORTS = [8898, 8899] as const;

export const CANONICAL_REMOTE = "https://github.com/Latand/live-log-viewer-next.git";

export interface Config {
  checkout: string;
  configRoot: string;
  webPort: number;
  port: number;
  remote: string;
  branch: string;
  pollMinutes: number;
  bun: string;
  processesFile: string;
}

const FLAGS: Record<string, string> = {
  "--checkout": "SELF_UPDATE_CHECKOUT",
  "--config-root": "SELF_UPDATE_CONFIG_ROOT",
  "--web-port": "SELF_UPDATE_WEB_PORT",
  "--port": "SELF_UPDATE_PORT",
  "--remote": "SELF_UPDATE_REMOTE",
  "--branch": "SELF_UPDATE_BRANCH",
  "--poll-minutes": "SELF_UPDATE_POLL_MINUTES",
  "--bun": "SELF_UPDATE_BUN",
  "--processes": "",
};

export function parseConfig(argv: string[], env: Record<string, string | undefined>, home: string): Config {
  const values = new Map<string, string>();
  let allowAnyRoot = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--allow-any-root") { allowAnyRoot = true; continue; }
    if (!(flag in FLAGS)) throw new Error(`Unknown flag ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    values.set(flag, value);
    index += 1;
  }
  const read = (flag: string): string | undefined => {
    const envName = FLAGS[flag];
    return values.get(flag) ?? (envName ? env[envName] : undefined) ?? undefined;
  };
  const required = (flag: string): string => {
    const value = read(flag);
    if (!value) throw new Error(`${flag} is required (or ${FLAGS[flag]})`);
    return value;
  };
  const integer = (flag: string, fallback?: number): number => {
    const raw = read(flag);
    if (raw === undefined) {
      if (fallback === undefined) throw new Error(`${flag} is required (or ${FLAGS[flag]})`);
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer, got ${raw}`);
    return value;
  };

  const checkout = resolve(required("--checkout"));
  const configRoot = resolve(required("--config-root"));
  assertIsolatedRoot(configRoot, home, allowAnyRoot);
  const webPort = integer("--web-port");
  if (webPort === 0) throw new Error("--web-port must name a port; the web process keeps it across restarts");
  if ((RESERVED_PORTS as readonly number[]).includes(webPort)) throw new Error(`Port ${webPort} is reserved for the operator's own Viewer`);
  const pollMinutes = integer("--poll-minutes", 60);
  if (pollMinutes < 1) throw new Error("--poll-minutes must be at least 1");
  return {
    checkout,
    configRoot,
    webPort,
    port: integer("--port", 0),
    remote: read("--remote") ?? CANONICAL_REMOTE,
    branch: read("--branch") ?? "main",
    pollMinutes,
    bun: read("--bun") ?? process.execPath,
    processesFile: resolve(values.get("--processes") ?? join(configRoot, "self-update", "processes.json")),
  };
}
