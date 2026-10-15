import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { copyDemoAudio, demoAudioUrls } from "./audioAssets";

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
    expect(urls).toContain("/audio/ambient/voice-call-loop.wav");
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

test("no audio path in the product's source escapes the copied set", () => {
  const urls = demoAudioUrls();
  const literals = sourceFiles(path.join(repo, "src")).flatMap((file) =>
    [...fs.readFileSync(file, "utf8").matchAll(/["'`](\/audio\/[^"'`]*)["'`]/g)].map((match) => match[1]!));
  expect(literals.length).toBeGreaterThan(0);
  for (const literal of literals) {
    const covered = urls.includes(literal) || urls.some((url) => url.startsWith(`${literal}/`));
    expect(`${literal} ${covered}`).toBe(`${literal} true`);
  }
});
