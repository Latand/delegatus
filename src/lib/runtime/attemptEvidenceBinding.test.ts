import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAttemptEvidenceBinding } from "./attemptEvidenceBinding";
import { preserveAttemptEvidence } from "./attemptTempEvidence";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root() { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-binding-")); roots.push(directory); return directory; }
test("the reader accepts the real writer's manifest beyond the recorded-check envelope bound", async () => {
  const directory = root();
  for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(directory, `capture-${i}-${"x".repeat(180)}.png`), "capture");
  const stat = fs.lstatSync(directory), identity = `${stat.dev}:${stat.ino}`;
  const saved = await preserveAttemptEvidence(directory, directory, identity, { pipelineId: "lane-fixture", launchId: "launch-fixture", register: () => {} });
  roots.push(saved.destination!);
  const file = path.join(saved.destination!, "manifest.json"); expect(fs.statSync(file).size).toBeGreaterThan(65536);
  expect(readAttemptEvidenceBinding(file)).toEqual({ original: directory, identity, pipelineId: "lane-fixture", launchId: "launch-fixture" });
});
test.each(["legacy", "escaped", "large"])("%s manifests retain their exact ownership strings", mode => {
  const file = path.join(root(), "manifest.json"), original = mode === "escaped" ? '/fixture/quoted-"files": [\\n' : "/fixture/source";
  fs.writeFileSync(file, JSON.stringify({ original, identity: "17:23", files: mode === "large" ? Array(50000).fill({ path: "capture.png" }) : [] }));
  expect(readAttemptEvidenceBinding(file)).toMatchObject({ original, identity: "17:23" });
});
test.each(["symlink", "hardlink", "invalid", "truncated"])("a %s manifest refuses ownership", mode => {
  const directory = root(), file = path.join(directory, "manifest.json"), source = path.join(directory, "source.json");
  fs.writeFileSync(source, JSON.stringify({ original: "/fixture", identity: "17:23", files: [] }));
  if (mode === "symlink") fs.symlinkSync(source, file);
  else if (mode === "hardlink") fs.linkSync(source, file);
  else fs.writeFileSync(file, mode === "invalid" ? '{"original":"/fixture","identity":"invalid"}' : '{"original":"/fixture","identity":"17:23","files":[');
  expect(() => readAttemptEvidenceBinding(file)).toThrow();
});
