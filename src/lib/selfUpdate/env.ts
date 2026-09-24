/* The environment an update's commands run under (#2007, checkout mode).
   It starts from the Viewer's own environment and drops everything that
   could point a build at the running install: the serving process's state
   and socket (`LLV_*`), a leaked serialized Next config (`__NEXT_*`, which
   bypasses next.config.ts), `NODE_ENV`, and the port and host the web
   process listens on. The build gets a scratch state directory of its own
   (#1905: a script that only needs *a* state directory sets LLV_STATE_DIR,
   never an owner token) and its own temp directory. */
import { join } from "node:path";

const DROPPED_PREFIX = /^(LLV_|NEXT_|__NEXT_)/;
const DROPPED_KEYS = new Set(["PORT", "HOSTNAME", "NODE_ENV", "TMPDIR"]);

export function buildEnv(scratchRoot: string, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || DROPPED_PREFIX.test(key) || DROPPED_KEYS.has(key)) continue;
    env[key] = value;
  }
  env.LLV_STATE_DIR = join(scratchRoot, "build-state");
  env.TMPDIR = join(scratchRoot, "tmp");
  env.GIT_TERMINAL_PROMPT = "0";
  /* Inlined at build time; the Dockerfile's build sets the same. */
  env.NEXT_PUBLIC_RUNTIME_UI = "1";
  return env;
}
