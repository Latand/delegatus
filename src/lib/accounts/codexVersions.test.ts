import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CODEX_PROTOCOL_MANIFESTS, SUPPORTED_CODEX_VERSIONS, latestCodexVersions } from "./codexVersions";

test("the supported window uses the retained reviewed schema inventory", () => {
  const retained = fs.readdirSync(path.join(import.meta.dir, "protocol")).filter(version => /^\d+\.\d+\.\d+$/.test(version));
  expect(CODEX_PROTOCOL_MANIFESTS.map(pin => pin.version).toSorted()).toEqual(retained.toSorted());
  expect(SUPPORTED_CODEX_VERSIONS).toEqual(latestCodexVersions(retained));
  expect(SUPPORTED_CODEX_VERSIONS).toEqual(retained.sort((a, b) => b.localeCompare(a, "en", { numeric: true })).slice(0, 3));
});

test("a new reviewed version rotates the oldest out regardless of source order", () => {
  const versions = Object.freeze(["0.9.0", "0.11.0", "0.10.0"]);
  expect(latestCodexVersions(versions)).toEqual(["0.11.0", "0.10.0", "0.9.0"]);
  expect(latestCodexVersions(["0.12.0", ...versions])).toEqual(["0.12.0", "0.11.0", "0.10.0"]);
  expect(versions).toEqual(["0.9.0", "0.11.0", "0.10.0"]);
});

test("numeric ordering includes major, minor and patch versions", () => {
  expect(latestCodexVersions(["0.99.0", "1.2.9", "1.2.10", "1.10.0", "1.2.0"]))
    .toEqual(["1.10.0", "1.2.10", "1.2.9"]);
});

test.each([["0.1.0"], ["0.1.0", "0.2.0"]])("a shorter supported inventory stays non-empty: %j", (...versions) => {
  expect(latestCodexVersions(versions)).toEqual([...versions].reverse());
});

test.each([[], ["0.1.0", "0.1.0"], ["latest"], ["0.2.0-beta.1"], ["0.2"], [""]])("invalid inventories fail instead of creating a green empty matrix: %j", (...versions) => {
  expect(() => latestCodexVersions(versions)).toThrow("non-empty list of unique stable versions");
});
