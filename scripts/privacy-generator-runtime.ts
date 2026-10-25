import { resolve } from "node:path";
import { withoutUnsupportedApiCredentials } from "../src/lib/environmentIsolation";

/** Raster provenance is pinned independently of the application's Bun version. */
export const PRIVACY_GENERATOR_BUN_VERSION = "1.3.3";

let cached: { configured: string | undefined; executable: string } | undefined;

export function privacyGeneratorRuntime(): string {
  const configured = process.env.LLV_PRIVACY_GENERATOR_BUN?.trim() || undefined;
  if (cached && cached.configured === configured) return cached.executable;
  if (!configured && Bun.version === PRIVACY_GENERATOR_BUN_VERSION) return process.execPath;
  const found = Bun.which(configured ?? `bun-${PRIVACY_GENERATOR_BUN_VERSION}`);
  const executable = found ? resolve(found) : null;
  if (executable) {
    try {
      const version = Bun.spawnSync([executable, "--version"], {
        env: withoutUnsupportedApiCredentials(process.env),
        stdout: "pipe", stderr: "pipe", timeout: 5_000,
      });
      if (version.exitCode === 0 && version.stdout.toString().trim() === PRIVACY_GENERATOR_BUN_VERSION) {
        cached = { configured, executable };
        return executable;
      }
    } catch { /* Report the required version without publishing an executable path. */ }
  }
  throw new Error(`Privacy placeholder generation requires Bun ${PRIVACY_GENERATOR_BUN_VERSION}; set LLV_PRIVACY_GENERATOR_BUN to that executable`);
}
