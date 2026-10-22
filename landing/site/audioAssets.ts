/*
 * The audio files the demo's Viewer can request, and their copy into dist/.
 *
 * The Viewer asks for its typing slices at the site root (`/audio/cues/…`,
 * warmed on the visitor's first gesture); every other sound is synthesized and
 * requests nothing. The list comes from the product's own table, so a file
 * added to it is copied by the next build, and a file the table names but
 * `public/` lacks fails the build.
 *
 * The music bed (`/audio/ambient/…`, a 5 MB lossless WAV) stays out of the
 * landing: the demo bundle swaps the product's loop-asset module for
 * `DEMO_LOOP_ASSET_SOURCE`, which configures no asset. The Viewer's own
 * supported "no loop asset" state then leaves the loop controls out of the
 * sound menu, and nothing requests the bed.
 */
import fs from "node:fs";
import path from "node:path";

import { typingAssetAll } from "@/lib/audio/cues";

export function demoAudioUrls(): string[] {
  return [...new Set(typingAssetAll())];
}

/** Path suffix of the product module the demo bundle replaces. */
export const LOOP_ASSET_MODULE = "/src/lib/audio/loopAsset.ts";

/** What the demo bundle loads in place of the loop-asset module: the same exports, no asset. */
export const DEMO_LOOP_ASSET_SOURCE = `export const AMBIENT_LOOP_ASSET: string | null = null;
export function ambientLoopConfigured(asset: string | null = AMBIENT_LOOP_ASSET): boolean {
  return typeof asset === "string" && asset.length > 0;
}
`;

/** Copies each file from `<repo>/public` to the same URL path under `dist`, and returns the URLs. */
export function copyDemoAudio(repo: string, dist: string): string[] {
  const urls = demoAudioUrls();
  for (const url of urls) {
    const from = path.join(repo, "public", url);
    const to = path.join(dist, url);
    if (!fs.existsSync(from)) throw new Error(`the demo requests ${url}, which public/ does not hold`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (!fs.existsSync(to)) throw new Error(`${url} is missing from dist after the copy`);
  }
  return urls;
}
