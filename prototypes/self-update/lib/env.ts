/* The environment every child of the prototype runs under. It starts from the
   prototype's own environment, drops everything that could point a child at
   the operator's installation, and points state, cache and temp at the
   isolated root. Mirrors what bin/cli.mjs (buildChildEnv,
   cliRuntimeHostEnvironment) gives a packaged install. */
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export type ChildRole = "build" | "web" | "runtime-host";

const DROPPED_PREFIX = /^(LLV_|NEXT_|__NEXT_)/;
const DROPPED_KEYS = ["PORT", "HOSTNAME", "NODE_ENV", "NEXT_DEPLOYMENT_ID", "TMPDIR"];
const TEMP_ROOTS = ["/tmp", "/var/tmp"];

function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/* Refuses a root under ~/.config whatever the flags say, and anything outside
   the temp directories unless the caller asked for it. */
export function assertIsolatedRoot(root: string, home: string = homedir(), allowAnyRoot = false): void {
  const absolute = resolve(root);
  if (inside(absolute, join(home, ".config"))) {
    throw new Error(`Config root ${absolute} is under ~/.config; the prototype never touches the operator's configuration`);
  }
  if (!allowAnyRoot && !TEMP_ROOTS.some((temp) => inside(absolute, temp))) {
    throw new Error(`Config root ${absolute} must be under /tmp or /var/tmp (pass --allow-any-root to override)`);
  }
}

export interface EnvInput { configRoot: string; webPort: number }

export function childEnv(input: EnvInput, role: ChildRole, base: Record<string, string | undefined> = process.env): Record<string, string> {
  assertIsolatedRoot(input.configRoot, homedir(), true);
  const root = resolve(input.configRoot);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || DROPPED_PREFIX.test(key) || DROPPED_KEYS.includes(key)) continue;
    env[key] = value;
  }
  const state = join(root, "state");
  Object.assign(env, {
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: join(root, "cache"),
    LLV_STATE_DIR: state,
    TMPDIR: join(root, "tmp"),
    LLV_RUNTIME_HOST_SOCKET: join(state, "runtime-host.sock"),
    LLV_RUNTIME_HOST_FENCE: join(state, "runtime-host.sock.lock"),
    LLV_RUNTIME_JOURNAL: join(state, "runtime-events.sqlite"),
    LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1",
    LLV_SPAWN_TRANSPORT: "structured",
    NEXT_PUBLIC_RUNTIME_UI: "1",
  });
  if (role === "web") {
    env.LLV_STATE_OWNER = "viewer";
    env.PORT = String(input.webPort);
    env.HOSTNAME = "127.0.0.1";
  }
  return env;
}

export function runtimePaths(configRoot: string): { socket: string; fence: string; tmp: string; state: string; cache: string } {
  const root = resolve(configRoot);
  const state = join(root, "state");
  return { socket: join(state, "runtime-host.sock"), fence: join(state, "runtime-host.sock.lock"), tmp: join(root, "tmp"), state, cache: join(root, "cache") };
}
