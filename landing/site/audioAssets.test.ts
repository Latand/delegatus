import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { copyDemoAudio, demoAudioUrls, DEMO_LOOP_ASSET_SOURCE, LOOP_ASSET_MODULE } from "./audioAssets";

const repo = path.resolve(import.meta.dir, "../..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

test("every audio file the product's tables name is copied into dist, byte for byte", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "landing-audio-"));
  try {
    const urls = copyDemoAudio(repo, dist);
    expect(urls).toEqual(demoAudioUrls());
    expect(urls.filter((url) => url.startsWith("/audio/cues/")).length).toBe(13);
    expect(urls.some((url) => url.startsWith("/audio/ambient/"))).toBe(false);
    expect(fs.existsSync(path.join(dist, "audio/ambient"))).toBe(false);
    for (const url of urls) {
      expect(fs.readFileSync(path.join(dist, url)).equals(fs.readFileSync(path.join(repo, "public", url)))).toBe(true);
    }
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test("a file the tables name but public/ lacks fails the build instead of shipping a 404", () => {
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "landing-audio-"));
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "landing-audio-"));
  try {
    expect(() => copyDemoAudio(emptyRepo, dist)).toThrow(/public\/ does not hold/);
  } finally {
    fs.rmSync(emptyRepo, { recursive: true, force: true });
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test("no audio path in the product's source escapes the copied set, except the music bed the demo bundle replaces", () => {
  const urls = demoAudioUrls();
  const literals = sourceFiles(path.join(repo, "src")).flatMap((file) =>
    [...fs.readFileSync(file, "utf8").matchAll(/["'`](\/audio\/[^"'`]*)["'`]/g)].map((match) => ({ file, url: match[1]! })));
  expect(literals.length).toBeGreaterThan(0);
  for (const { file, url } of literals) {
    const covered = urls.includes(url) || urls.some((copied) => copied.startsWith(`${url}/`));
    const replaced = file.endsWith(LOOP_ASSET_MODULE) && url.startsWith("/audio/ambient/");
    expect(`${url} ${covered || replaced}`).toBe(`${url} true`);
  }
  expect(literals.some(({ file }) => file.endsWith(LOOP_ASSET_MODULE))).toBe(true);
});

test("the module the demo bundle loads configures no music bed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-audio-"));
  try {
    const file = path.join(dir, "loopAsset.ts");
    fs.writeFileSync(file, DEMO_LOOP_ASSET_SOURCE);
    const stub = await import(file);
    expect(stub.AMBIENT_LOOP_ASSET).toBeNull();
    expect(stub.ambientLoopConfigured()).toBe(false);
    expect(DEMO_LOOP_ASSET_SOURCE).not.toContain("/audio/");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
