import currentManifest from "./protocol/0.167.0/manifest.json";
import latestPriorManifest from "./protocol/0.166.0/manifest.json";
import newestPriorManifest from "./protocol/0.165.0/manifest.json";
import lastManifest from "./protocol/0.164.0/manifest.json";
import recentManifest from "./protocol/0.163.0/manifest.json";
import priorManifest from "./protocol/0.162.1/manifest.json";
import previousManifest from "./protocol/0.159.0/manifest.json";
import oldestManifest from "./protocol/0.154.0/manifest.json";

/** Retained reviewed schemas, including historical compatibility fixtures. */
export const CODEX_PROTOCOL_MANIFESTS = [
  currentManifest, latestPriorManifest, newestPriorManifest, lastManifest, recentManifest,
  priorManifest, previousManifest, oldestManifest,
];

/** The supported/tested window advances whenever a reviewed pin is added. */
export function latestCodexVersions(versions: readonly string[]): string[] {
  if (!versions.length || versions.some(version => !/^\d+\.\d+\.\d+$/.test(version))
    || new Set(versions).size !== versions.length) {
    throw new Error("Codex pins must be a non-empty list of unique stable versions");
  }
  return [...versions].sort((left, right) => {
    const a = left.split(".").map(Number), b = right.split(".").map(Number);
    return b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!;
  }).slice(0, 3);
}

export const SUPPORTED_CODEX_VERSIONS = latestCodexVersions(CODEX_PROTOCOL_MANIFESTS.map(pin => pin.version));
