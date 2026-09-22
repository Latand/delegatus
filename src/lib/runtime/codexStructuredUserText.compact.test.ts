import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { readStructuredUserMetadata } from "@/lib/selection/structuredUserMetadata";
import { selectedContextArg } from "@/lib/mcp/selectedContextTarget";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";
import { decodeCodexStructuredUserText as decodeWire, structuredUserReferenceKey } from "./codexStructuredUserText";
import { encodeCodexStructuredUserText as legacyEncode } from "./codexStructuredUserText.legacy.fixture";
import { decodeCodexStructuredUserText as decode, encodeCodexStructuredUserText as encode } from "./codexStructuredUserText.server";

const selected: SelectedContextRef = {
  version: 1, state: "selected", conversationId: "conversation_fixture_card",
  capturedAt: "2026-09-22T00:00:00.000Z", project: "repo-fixture", viewSessionId: "fixture-view",
  deviceId: "fixture-device", revision: 1, path: "fixtures/sessions/selected-card.jsonl", label: "Selected fixture card",
};
const none: SelectedContextRef = { version: 1, state: "none", capturedAt: selected.capturedAt,
  project: selected.project, viewSessionId: selected.viewSessionId, deviceId: selected.deviceId, revision: 1 };
const dedup = (value: string) => createHash("sha256").update(value).digest("hex");
let directory: string;
let previous: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "compact-marker-"));
  previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = directory;
});
afterEach(() => {
  if (previous === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

test("production delivery markers fit 96 characters with selected, empty, absent and agent contexts", () => {
  for (const [name, context, origin] of [
    ["selected", selected, { kind: "operator" }],
    ["none", none, { kind: "operator" }],
    ["absent", null, { kind: "operator" }],
    ["agent", selected, { kind: "agent", role: "orchestrator" }],
    ["long-role", selected, { kind: "agent", role: "r".repeat(64) }],
  ] as const) {
    const wire = encode("Fixture message", undefined, context, origin, dedup(name));
    expect(wire.split("\n")[0]!.length).toBeLessThanOrEqual(96);
    expect(decodeWire(wire).metadataRef).toMatch(/^[oad]\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}$/);
    expect(wire).not.toContain("fixture_card");
    expect(decode(wire)).toMatchObject({ text: "Fixture message", selectedContext: context, origin, deliveryDedup: dedup(name) });
    expect(decodeWire(wire).deliveryDedup).toBe(dedup(name));
  }
});

test("legacy long ctx, digest-only and bare markers retain exactly their decoded values", () => {
  for (const wire of [
    legacyEncode("Keep these bytes.\n", "b".repeat(64), selected, { kind: "agent", role: "reviewer" }, dedup("legacy")),
    `<!-- llv:structured-user sha256=${"b".repeat(64)} -->\nKeep these bytes.\n`,
    "<!-- llv:structured-user -->\nKeep these bytes.\n",
  ]) expect(decode(wire)).toEqual(decodeWire(wire));
});

test("an image-only operator delivery preserves its content digest after trimming", () => {
  const wire = encode("", "b".repeat(64), selected, { kind: "operator" }, dedup("image"));
  expect(wire.split("\n")[0]!.length).toBeLessThanOrEqual(96);
  expect(decode(wire.trimEnd())).toMatchObject({ text: "", structured: true, contentDigest: "b".repeat(64), origin: { kind: "operator" } });
});

test("recipient-scoped queue ids can coexist with different image metadata", () => {
  const identity = dedup("shared-native-entry-v1");
  const first = encode("queued input", "a".repeat(64), selected, { kind: "operator" }, identity);
  const second = encode("queued input", "b".repeat(64), selected, { kind: "operator" }, identity);
  expect(decodeWire(first).metadataRef).not.toBe(decodeWire(second).metadataRef);
  expect(decodeWire(first).deliveryDedup).toBe(identity);
  expect(decodeWire(second).deliveryDedup).toBe(identity);
  expect(decode(first).contentDigest).toBe("a".repeat(64));
  expect(decode(second).contentDigest).toBe("b".repeat(64));
  expect(second.split("\n")[0]!.length).toBeLessThanOrEqual(96);
});

test("a fresh process resolves the exact admitted card from the shared state directory", () => {
  const wire = encode("Fixture message", undefined, selected, { kind: "operator" }, dedup("restart"));
  const ref = decodeWire(wire).metadataRef!;
  const moduleUrl = new URL("../mcp/selectedContextTarget.ts", import.meta.url).href;
  const child = Bun.spawnSync([process.execPath, "-e",
    `const {selectedContextArg}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(selectedContextArg(${JSON.stringify(`ctx=${ref}`)})));`],
  { env: { ...process.env, LLV_STATE_DIR: directory }, cwd: tmpdir() });
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual(selected);
  expect(selectedContextArg(ref)).toEqual(selected);
});

test("a missing or corrupted handle refuses while another card with the same recipient-scoped id remains readable", () => {
  const wire = encode("Fixture message", undefined, selected, { kind: "operator" }, dedup("immutable"));
  const ref = decodeWire(wire).metadataRef!;
  const other = encode("Fixture message", undefined, { ...selected, conversationId: "conversation_other_fixture" },
    { kind: "operator" }, dedup("immutable"));
  const otherRef = decodeWire(other).metadataRef!;
  expect(otherRef).not.toBe(ref);
  expect(readStructuredUserMetadata(ref).selectedContext).toEqual(selected);
  const file = (handle: string) => join(directory, "structured-user-metadata", `${handle[0]}-${structuredUserReferenceKey(handle)}-${handle.split(".")[2]}.json`);
  writeFileSync(file(ref), readFileSync(file(otherRef)));
  expect(() => selectedContextArg(ref)).toThrow("unavailable");
  unlinkSync(file(ref));
  expect(() => selectedContextArg(ref)).toThrow("unavailable");
  expect(() => decode(wire)).toThrow("unavailable");
  expect(selectedContextArg(otherRef)?.state === "selected" && decode(other).selectedContext).toMatchObject({ conversationId: "conversation_other_fixture" });
});
