/*
 * The audio files the demo's Viewer can request, and their copy into dist/.
 *
 * The Viewer asks for its cues at the site root (`/audio/cues/…`, warmed on
 * the visitor's first gesture) and for its music bed (`/audio/ambient/…`, when
 * the visitor switches it on in the sound menu). The list comes from the
 * product's own tables, so a cue added to the product is copied by the next
 * build, and a file the tables name but `public/` lacks fails the build.
 */
import fs from "node:fs";
import path from "node:path";

import { CUES, cueAssetAll, type AudioCue } from "@/lib/audio/cues";
import { AMBIENT_LOOP_ASSET } from "@/lib/audio/loopAsset";

export function demoAudioUrls(): string[] {
  const urls = Object.keys(CUES).flatMap((cue) => cueAssetAll(cue as AudioCue));
  if (AMBIENT_LOOP_ASSET) urls.push(AMBIENT_LOOP_ASSET);
  return [...new Set(urls)];
}

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
