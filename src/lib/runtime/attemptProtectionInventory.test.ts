import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { AttemptProtectionInventory, forgetAttemptProtection, type ProtectionMarker } from "./attemptProtectionInventory";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });
const version = (file: string) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return [stat.dev, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
};
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "protection-inventory-"));
  const original = path.join(parent, "original"), trash = path.join(parent, "trash"), child = path.join(original, "child");
  fs.mkdirSync(child, { recursive: true, mode: 0o755 });
  cleanup.push(() => { forgetAttemptProtection(original); forgetAttemptProtection(trash); fs.rmSync(parent, { recursive: true, force: true }); });
  return { original, trash, child };
}

test("a completed writer inventory reopens under quarantine and preserves marker bytes", () => {
  const f = fixture(), marker = path.join(f.child, ".delegatus-keep");
  fs.writeFileSync(marker, "retained marker");
  const directories = new Map([[f.original, version(f.original)], [f.child, version(f.child)]]);
  const markers = new Map([[marker, { version: version(marker), content: fs.readFileSync(marker) }]]);
  const writer = new AttemptProtectionInventory(f.original, version(f.original));
  writer.seed(directories, [...directories.keys()], markers, []); writer.close();
  fs.renameSync(f.original, f.trash);
  const reader = new AttemptProtectionInventory(f.trash, version(f.trash), f.original);
  try {
    expect(reader.pending()).toBeUndefined();
    const copied = new Map<string, string>(), readable: string[] = [], copiedMarkers = new Map<string, ProtectionMarker>();
    reader.load(copied, readable, copiedMarkers, () => {});
    expect(copied).toEqual(new Map([[f.trash, version(f.trash)], [path.join(f.trash, "child"), version(path.join(f.trash, "child"))]]));
    expect(readable.sort()).toEqual([...copied.keys()].sort());
    expect(copiedMarkers.get(path.join(f.trash, "child/.delegatus-keep"))).toEqual(markers.get(marker));
  } finally { reader.close(); }
});

test.each(["pending", "changed-mode"] as const)("a quarantine refuses an incomplete or rebound root (%s)", cause => {
  const f = fixture(), writer = new AttemptProtectionInventory(f.original, version(f.original));
  writer.record(f.original, version(f.original), true, [f.child], new Map());
  if (cause === "changed-mode") writer.record(f.child, version(f.child), true, [], new Map());
  writer.close(); fs.renameSync(f.original, f.trash);
  if (cause === "changed-mode") fs.chmodSync(f.trash, (fs.statSync(f.trash).mode & 0o777) ^ 0o020);
  const reader = new AttemptProtectionInventory(f.trash, version(f.trash), f.original);
  try { expect(reader.pending()).toBe(f.trash); } finally { reader.close(); }
});

test("inventory writers reject paths their recovery reader cannot admit", () => {
  const f = fixture(), writer = new AttemptProtectionInventory(f.original, version(f.original));
  try {
    const outside = path.join(path.dirname(f.original), "outside");
    expect(() => writer.record(outside, "version", true, [], new Map())).toThrow("escaped its root");
    expect(() => writer.record(f.original, version(f.original), true, [outside], new Map())).toThrow("escaped its root");
    expect(() => writer.record(f.original, version(f.original), true, [], new Map([[outside, { version: "marker" }]]))).toThrow("escaped its root");
    expect(() => writer.seed(new Map(), [], new Map(), [outside])).toThrow("escaped its root");
    expect(writer.pending()).toBe(f.original);
  } finally { writer.close(); }
});
