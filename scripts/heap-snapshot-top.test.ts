import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeHeapSnapshot } from "./heap-snapshot-top";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "heap-snapshot-top-"));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const NODE_TYPES = ["hidden", "array", "string", "object", "code", "closure", "regexp", "number", "native", "synthetic", "concatenated string", "sliced string", "symbol", "bigint", "object shape"];
const EDGE_TYPES = ["context", "element", "property", "internal", "hidden", "shortcut", "weak"];

/** A snapshot file in the layout the Bun runtime writes. */
function write(name: string, nodes: Array<{ type: string; name: string; self: number; edges: Array<{ type: string; name: string | number; to: number }> }>) {
  const strings: string[] = [];
  const stringId = (value: string) => { const at = strings.indexOf(value); return at >= 0 ? at : strings.push(value) - 1; };
  const nodeValues: number[] = [], edgeValues: number[] = [];
  nodes.forEach((node, id) => {
    nodeValues.push(NODE_TYPES.indexOf(node.type), stringId(node.name), id + 1, node.self, node.edges.length, 0, 0);
    for (const edge of node.edges) edgeValues.push(EDGE_TYPES.indexOf(edge.type), typeof edge.name === "number" ? edge.name : stringId(edge.name), edge.to * 7);
  });
  const meta = { node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"], node_types: [NODE_TYPES, "string", "number", "number", "number", "number", "number"],
    edge_fields: ["type", "name_or_index", "to_node"], edge_types: [EDGE_TYPES, "string_or_number", "node"] };
  const file = path.join(root, name);
  fs.writeFileSync(file, `{"snapshot":{"meta":${JSON.stringify(meta)},"node_count":${nodes.length},"edge_count":${edgeValues.length / 3},"trace_function_count":0},\n"nodes":[${nodeValues.join(",")}],\n"edges":[${edgeValues.join(",")}],\n"trace_function_infos":[],\n"trace_tree": [],\n"samples":[],\n"locations":[],\n"strings":${JSON.stringify(strings)}\n}\n`);
  return file;
}

test("retained sizes follow the dominator tree, nested instances count once, weak edges retain nothing", () => {
  const file = write("graph.heapsnapshot", [
    /* 0 */ { type: "synthetic", name: "(GC roots)", self: 0, edges: [{ type: "internal", name: "a", to: 1 }, { type: "internal", name: "b", to: 2 }] },
    /* 1 */ { type: "object", name: "Cache", self: 10, edges: [{ type: "property", name: "rows", to: 3 }, { type: "property", name: "shared", to: 5 }, { type: "weak", name: "ghost", to: 6 }] },
    /* 2 */ { type: "object", name: "Other", self: 5, edges: [{ type: "property", name: "shared", to: 5 }] },
    /* 3 */ { type: "object", name: "Row", self: 100, edges: [{ type: "element", name: 0, to: 4 }, { type: "property", name: "inner", to: 7 }, { type: "property", name: "text", to: 8 }] },
    /* 4 */ { type: "object", name: "Leaf", self: 1000, edges: [] },
    /* 5 */ { type: "object", name: "Shared", self: 7, edges: [] },
    /* 6 */ { type: "object", name: "Ghost", self: 3, edges: [] },
    /* 7 */ { type: "object", name: "Cache", self: 20, edges: [] },
    /* 8 */ { type: "string", name: 'private "content" ] with \\ brackets', self: 50, edges: [] },
  ]);
  const summary = analyzeHeapSnapshot(file, 3);
  const row = (type: string) => summary.types.find(entry => entry.type === type);
  expect(summary).toMatchObject({ nodeCount: 9, edgeCount: 9, totalSelfSize: 1195, reachableCount: 8, reachableSelfSize: 1192 });
  expect(row("Cache")).toEqual({ type: "Cache", count: 2, selfSize: 30, retainedSize: 1180 });
  expect(row("Row")).toEqual({ type: "Row", count: 1, selfSize: 100, retainedSize: 1170 });
  expect(row("Leaf")).toEqual({ type: "Leaf", count: 1, selfSize: 1000, retainedSize: 1000 });
  expect(row("Other")).toEqual({ type: "Other", count: 1, selfSize: 5, retainedSize: 5 });
  expect(row("Shared")).toEqual({ type: "Shared", count: 1, selfSize: 7, retainedSize: 7 });
  expect(row("Ghost")).toEqual({ type: "Ghost", count: 1, selfSize: 3, retainedSize: 3 });
  expect(row("(string)")).toEqual({ type: "(string)", count: 1, selfSize: 50, retainedSize: 50 });
  expect(summary.objects).toEqual([
    { type: "Cache", selfSize: 10, retainedSize: 1180, heldBy: '(synthetic) via internal "a"' },
    { type: "Row", selfSize: 100, retainedSize: 1170, heldBy: 'Cache via property "rows"' },
    { type: "Leaf", selfSize: 1000, retainedSize: 1000, heldBy: "Row via element [0]" },
  ]);
  expect(JSON.stringify(summary)).not.toContain("private");
});

test("an object reachable several ways names its direct referrers", () => {
  const file = write("shared.heapsnapshot", [
    { type: "synthetic", name: "(GC roots)", self: 0, edges: [{ type: "internal", name: "a", to: 1 }, { type: "internal", name: "b", to: 2 }] },
    { type: "object", name: "Left", self: 1, edges: [{ type: "property", name: "cache", to: 3 }] },
    { type: "object", name: "Right", self: 1, edges: [{ type: "property", name: "mirror", to: 3 }] },
    { type: "object", name: "Map", self: 500, edges: [] },
  ]);
  const [largest] = analyzeHeapSnapshot(file, 1).objects;
  expect(largest).toMatchObject({ type: "Map", retainedSize: 500 });
  expect(largest!.heldBy.split("; ").sort()).toEqual(['Left via property "cache"', 'Right via property "mirror"']);
});

test("a snapshot the runtime writes is read whole and its sizes add up", () => {
  const holder = Array.from({ length: 2000 }, (_, index) => ({ index, label: `row ${index}` }));
  const bytes = (globalThis as unknown as { Bun: { generateHeapSnapshot(format: "v8", encoding: "arraybuffer"): ArrayBuffer } }).Bun.generateHeapSnapshot("v8", "arraybuffer");
  const file = path.join(root, "live.heapsnapshot");
  fs.writeFileSync(file, new Uint8Array(bytes));
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { snapshot: { node_count: number; edge_count: number }; nodes: number[] };
  let self = 0;
  for (let at = 3; at < parsed.nodes.length; at += 7) self += parsed.nodes[at]!;
  const summary = analyzeHeapSnapshot(file);
  expect(summary.nodeCount).toBe(parsed.snapshot.node_count);
  expect(summary.edgeCount).toBe(parsed.snapshot.edge_count);
  expect(summary.totalSelfSize).toBe(self);
  expect(summary.types.reduce((sum, entry) => sum + entry.count, 0)).toBe(summary.nodeCount);
  expect(summary.types.find(entry => entry.type === "Object")!.count).toBeGreaterThanOrEqual(holder.length);
  expect(summary.objects.length).toBe(30);
});
