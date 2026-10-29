import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildManifest, verifyManifest, digest, readEnvelope, writeEnvelope, ownedFile } from "./wire";
import { recordedCheckInput } from "./input";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recorded-wire-")); roots.push(root);
  fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
  const input = { cwd: root, deadline: 1_900_000_000_000, executionMs: 1000, selection: ["first", "second"],
    configurationDigest: digest({ fixture: true }), roots: [{ directory: root, purpose: "evidence" as const }],
    inputs: [{ root, file: "source.ts" }], outputs: [{ root, file: "late.patch" }], completion: { root, file: "complete.json" } };
  return { root, input, manifest: await buildManifest(input) };
}
test("the production manifest binds exact source bytes and ordered selection before late outputs exist", async () => {
  const f = await fixture(); await verifyManifest(f.manifest);
  const destination = path.join(f.root, "manifest.json"); writeEnvelope(destination, f.manifest);
  expect(readEnvelope(destination)).toEqual(f.manifest);
  expect(f.manifest.selection).toEqual(["first", "second"]);
  fs.writeFileSync(path.join(f.root, "source.ts"), "changed\n");
  await expect(verifyManifest(f.manifest)).rejects.toThrow("source changed");
});
test("root recycling, indirect parents, symlinks, hardlinks and traversal never become evidence authority", async () => {
  const f = await fixture();
  fs.renameSync(path.join(f.root, "source.ts"), path.join(f.root, "target.ts"));
  fs.symlinkSync(path.join(f.root, "target.ts"), path.join(f.root, "source.ts"));
  await expect(verifyManifest(f.manifest)).rejects.toThrow("indirect path");
  fs.unlinkSync(path.join(f.root, "source.ts"));
  fs.linkSync(path.join(f.root, "target.ts"), path.join(f.root, "source.ts"));
  expect(() => ownedFile(f.root, "source.ts")).toThrow("regular file");
  expect(() => ownedFile(f.root, "../target.ts")).toThrow();
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.root, alias);
  await expect(buildManifest({ ...f.input, roots: [{ directory: alias, purpose: "evidence" }] })).rejects.toThrow("indirect parent");
});
test("foreign roots, repeated selections and unbounded envelopes refuse before registration", async () => {
  const f = await fixture();
  await expect(verifyManifest({ ...f.manifest, outputs: [{ root: path.dirname(f.root), file: "foreign" }] })).rejects.toThrow("outside");
  await expect(buildManifest({ ...f.input, selection: ["same", "same"] })).rejects.toThrow("duplicate");
  expect(() => writeEnvelope(path.join(f.root, "large"), "a".repeat(65536))).toThrow("bound");
  fs.writeFileSync(path.join(f.root, "large"), " ".repeat(65537));
  expect(() => readEnvelope(path.join(f.root, "large"))).toThrow("envelope");
});
test("the tool admits no command, substituted owner or missing action", () => {
  for (const extra of [{ command: ["true"] }, { conversationId: "foreign" }, { deadline: 1 }])
    expect(recordedCheckInput.strict().safeParse({ action: "handoff", ticket: "local.log", ...extra }).success).toBeFalse();
  expect(recordedCheckInput.safeParse({ ticket: "local.log" }).success).toBeFalse();
  expect(recordedCheckInput.parse({ action: "read", cursor: -10 }).cursor).toBe(0);
});
