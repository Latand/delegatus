#!/usr/bin/env bun
/*
 * Top object types of a V8-format heap snapshot (the `.heapsnapshot` file that
 * GET /api/operator/heap?mode=snapshot writes), by count and by retained size.
 *
 *   bun scripts/heap-snapshot-top.ts <file.heapsnapshot> [--top 30] [--json]
 *
 * Standalone: it imports nothing from the product and reads the file as a
 * byte stream, so a snapshot larger than one JavaScript string still loads.
 * Only type and property names are printed; string contents stay in the file.
 *
 * Retained size follows the usual heap-profiler definition: the bytes that
 * would be freed with the object, computed from the dominator tree over
 * non-weak edges. A type's retained size sums its instances that have no
 * instance of the same type above them in the dominator tree, so nested
 * instances are counted once. The last table lists the single objects that
 * retain the most, each with the property its dominator holds it by, which is
 * what names the owning cache.
 */
import fs from "node:fs";

interface Meta {
  node_fields: string[];
  node_types: [string[], ...unknown[]];
  edge_fields: string[];
  edge_types: [string[], ...unknown[]];
}
interface Header { snapshot: { meta: Meta; node_count: number; edge_count: number } }

export interface HeapSnapshotGraph {
  nodeCount: number;
  edgeCount: number;
  nodeTypes: string[];
  edgeTypes: string[];
  type: Uint8Array;
  name: Uint32Array;
  selfSize: Float64Array;
  edgeCounts: Uint32Array;
  edgeType: Uint8Array;
  edgeName: Uint32Array;
  edgeTo: Uint32Array;
}

const CHUNK = 32 * 1024 * 1024;
const QUOTE = 34, BACKSLASH = 92, COMMA = 44, CLOSE = 93, ZERO = 48, NINE = 57;

class ByteReader {
  private readonly fd: number;
  private readonly buffer = Buffer.allocUnsafe(CHUNK);
  private length = 0;
  private offset = 0;
  constructor(file: string) { this.fd = fs.openSync(file, "r"); }
  close() { fs.closeSync(this.fd); }
  /** The next byte, or -1 at the end of the file. */
  next(): number {
    if (this.offset === this.length) {
      this.length = fs.readSync(this.fd, this.buffer, 0, CHUNK, null);
      this.offset = 0;
      if (this.length === 0) return -1;
    }
    return this.buffer[this.offset++]!;
  }
  /** Consume through `marker`; returns the bytes before it when `keep` is set. */
  through(marker: string, keep = false): string {
    const want = Buffer.from(marker);
    const kept: number[] = [];
    let matched = 0;
    for (;;) {
      const byte = this.next();
      if (byte === -1) throw new Error(`snapshot ended before ${marker}`);
      if (keep) kept.push(byte);
      if (byte === want[matched]) {
        if (++matched === want.length) return keep ? Buffer.from(kept.slice(0, kept.length - want.length)).toString("utf8") : "";
      } else matched = byte === want[0] ? 1 : 0;
    }
  }
  /** Calls `each` for every unsigned integer of a JSON number array, up to its `]`. */
  integers(each: (value: number) => void): void {
    let value = 0, inNumber = false;
    for (;;) {
      const byte = this.next();
      if (byte >= ZERO && byte <= NINE) { value = value * 10 + (byte - ZERO); inNumber = true; continue; }
      if (inNumber) { each(value); value = 0; inNumber = false; }
      if (byte === CLOSE) return;
      if (byte === -1) throw new Error("snapshot ended inside a number array");
      if (byte !== COMMA && byte !== 10 && byte !== 13 && byte !== 32) throw new Error(`unexpected byte ${byte} in a number array`);
    }
  }
  /** Walks a JSON string array, decoding only the wanted indices. */
  strings(wanted: Set<number>): Map<number, string> {
    const found = new Map<number, string>();
    let index = 0, inString = false, escaped = false, collecting = false;
    let bytes: number[] = [];
    for (;;) {
      const byte = this.next();
      if (byte === -1) throw new Error("snapshot ended inside the string table");
      if (!inString) {
        if (byte === QUOTE) { inString = true; collecting = wanted.has(index); bytes = collecting ? [QUOTE] : bytes; }
        else if (byte === CLOSE) return found;
        continue;
      }
      if (collecting) bytes.push(byte);
      if (escaped) { escaped = false; continue; }
      if (byte === BACKSLASH) { escaped = true; continue; }
      if (byte === QUOTE) {
        if (collecting) found.set(index, JSON.parse(Buffer.from(bytes).toString("utf8")) as string);
        inString = false; index++;
      }
    }
  }
}

/** Second pass: the string table entries at the wanted indices. */
export function readHeapSnapshotStrings(file: string, wanted: Set<number>): Map<number, string> {
  const reader = new ByteReader(file);
  try {
    reader.through('"nodes":[');
    reader.integers(() => {});
    reader.through('"edges":[');
    reader.integers(() => {});
    reader.through('"strings":[');
    return reader.strings(wanted);
  } finally { reader.close(); }
}

export function readHeapSnapshot(file: string): HeapSnapshotGraph {
  const reader = new ByteReader(file);
  try {
    const head = reader.through('"nodes":[', true).replace(/,\s*$/, "");
    const header = JSON.parse(`${head}}`) as Header;
    const { meta, node_count: nodeCount, edge_count: edgeCount } = header.snapshot;
    const nodeFields = meta.node_fields.length, edgeFields = meta.edge_fields.length;
    const at = (fields: string[], field: string) => {
      const index = fields.indexOf(field);
      if (index < 0) throw new Error(`snapshot has no ${field} field`);
      return index;
    };
    const [typeAt, nameAt, selfAt, countAt] = ["type", "name", "self_size", "edge_count"].map(field => at(meta.node_fields, field));
    const [edgeTypeAt, edgeNameAt, edgeToAt] = ["type", "name_or_index", "to_node"].map(field => at(meta.edge_fields, field));

    const type = new Uint8Array(nodeCount), name = new Uint32Array(nodeCount);
    const selfSize = new Float64Array(nodeCount), edgeCounts = new Uint32Array(nodeCount);
    let position = 0;
    reader.integers(value => {
      const node = Math.floor(position / nodeFields), field = position % nodeFields;
      position++;
      if (node >= nodeCount) throw new Error("more node values than node_count declares");
      if (field === typeAt) type[node] = value;
      else if (field === nameAt) name[node] = value;
      else if (field === selfAt) selfSize[node] = value;
      else if (field === countAt) edgeCounts[node] = value;
    });
    if (position !== nodeCount * nodeFields) throw new Error("node array is shorter than node_count declares");

    reader.through('"edges":[');
    const edgeType = new Uint8Array(edgeCount), edgeTo = new Uint32Array(edgeCount), edgeName = new Uint32Array(edgeCount);
    position = 0;
    reader.integers(value => {
      const edge = Math.floor(position / edgeFields), field = position % edgeFields;
      position++;
      if (edge >= edgeCount) throw new Error("more edge values than edge_count declares");
      if (field === edgeTypeAt) edgeType[edge] = value;
      else if (field === edgeNameAt) edgeName[edge] = value;
      else if (field === edgeToAt) edgeTo[edge] = value / nodeFields;
    });
    if (position !== edgeCount * edgeFields) throw new Error("edge array is shorter than edge_count declares");

    return { nodeCount, edgeCount, nodeTypes: meta.node_types[0], edgeTypes: meta.edge_types[0], type, name, selfSize, edgeCounts, edgeType, edgeName, edgeTo };
  } finally { reader.close(); }
}

export interface TypeRow { type: string; count: number; selfSize: number; retainedSize: number }
export interface ObjectRow { type: string; selfSize: number; retainedSize: number; heldBy: string }
export interface HeapSnapshotSummary {
  nodeCount: number; edgeCount: number; totalSelfSize: number;
  reachableCount: number; reachableSelfSize: number;
  types: TypeRow[];
  /** The single objects that retain the most, largest first. */
  objects: ObjectRow[];
}

/** A label still to be resolved against the string table. */
type Label = { kind: string; nameId: number | null };
const NAMED_KINDS = new Set(["object", "native"]);

export function summarizeHeapSnapshot(graph: HeapSnapshotGraph, strings: (wanted: Set<number>) => Map<number, string>, topObjects = 30): HeapSnapshotSummary {
  const { nodeCount, edgeCount, edgeTo, edgeType, selfSize } = graph;
  const weak = graph.edgeTypes.indexOf("weak");
  const firstEdge = new Uint32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node++) firstEdge[node + 1] = firstEdge[node]! + graph.edgeCounts[node]!;
  if (firstEdge[nodeCount] !== edgeCount) throw new Error("edge counts do not add up to edge_count");

  // Postorder from the root (node 0), iteratively.
  const NONE = 0xffffffff;
  const postIndex = new Uint32Array(nodeCount).fill(NONE);
  const postNode = new Uint32Array(nodeCount);
  const visited = new Uint8Array(nodeCount);
  const stackNode = new Uint32Array(nodeCount), stackEdge = new Uint32Array(nodeCount);
  let depth = 0, reachableCount = 0;
  if (nodeCount > 0) { stackNode[0] = 0; stackEdge[0] = firstEdge[0]!; visited[0] = 1; depth = 1; }
  while (depth > 0) {
    const node = stackNode[depth - 1]!;
    const edge = stackEdge[depth - 1]!;
    if (edge < firstEdge[node + 1]!) {
      stackEdge[depth - 1] = edge + 1;
      if (edgeType[edge] === weak) continue;
      const to = edgeTo[edge]!;
      if (visited[to]) continue;
      visited[to] = 1;
      stackNode[depth] = to; stackEdge[depth] = firstEdge[to]!; depth++;
    } else {
      postIndex[node] = reachableCount; postNode[reachableCount] = node; reachableCount++; depth--;
    }
  }

  // Predecessors of reachable nodes, as postorder indices.
  const firstPredecessor = new Uint32Array(reachableCount + 1);
  for (let node = 0; node < nodeCount; node++) {
    if (!visited[node]) continue;
    for (let edge = firstEdge[node]!; edge < firstEdge[node + 1]!; edge++) {
      if (edgeType[edge] !== weak) firstPredecessor[postIndex[edgeTo[edge]!]! + 1]!++;
    }
  }
  for (let index = 0; index < reachableCount; index++) firstPredecessor[index + 1]! += firstPredecessor[index]!;
  const predecessors = new Uint32Array(firstPredecessor[reachableCount]!);
  const fill = firstPredecessor.slice(0, reachableCount);
  for (let node = 0; node < nodeCount; node++) {
    if (!visited[node]) continue;
    const from = postIndex[node]!;
    for (let edge = firstEdge[node]!; edge < firstEdge[node + 1]!; edge++) {
      if (edgeType[edge] !== weak) predecessors[fill[postIndex[edgeTo[edge]!]!]!++] = from;
    }
  }

  // Immediate dominators (Cooper, Harvey, Kennedy), over postorder indices.
  const dominator = new Uint32Array(reachableCount).fill(NONE);
  const rootIndex = reachableCount - 1;
  if (reachableCount > 0) dominator[rootIndex] = rootIndex;
  for (let changed = reachableCount > 1; changed;) {
    changed = false;
    for (let index = rootIndex - 1; index >= 0; index--) {
      let candidate = NONE;
      for (let at = firstPredecessor[index]!; at < firstPredecessor[index + 1]!; at++) {
        let other = predecessors[at]!;
        if (dominator[other] === NONE) continue;
        if (candidate === NONE) { candidate = other; continue; }
        while (candidate !== other) {
          while (candidate < other) candidate = dominator[candidate]!;
          while (other < candidate) other = dominator[other]!;
        }
      }
      if (candidate !== NONE && dominator[index] !== candidate) { dominator[index] = candidate; changed = true; }
    }
  }

  // A dominator always has the higher postorder index, so one ascending pass sums subtrees.
  const retained = new Float64Array(reachableCount);
  for (let index = 0; index < reachableCount; index++) retained[index] = selfSize[postNode[index]!]!;
  for (let index = 0; index < rootIndex; index++) retained[dominator[index]!]! += retained[index]!;

  // Named objects group by their class; everything else by its node kind.
  const classIds = new Map<number, number>();
  const classLabels: Label[] = [];
  const nodeClass = new Uint32Array(nodeCount);
  for (let node = 0; node < nodeCount; node++) {
    const kindId = graph.type[node]!;
    const named = NAMED_KINDS.has(graph.nodeTypes[kindId]!);
    const key = named ? graph.name[node]! : -(kindId + 1);
    let id = classIds.get(key);
    if (id === undefined) {
      id = classLabels.length; classIds.set(key, id);
      classLabels.push({ kind: graph.nodeTypes[kindId]!, nameId: named ? graph.name[node]! : null });
    }
    nodeClass[node] = id;
  }
  const classNames = classLabels;
  const rows: TypeRow[] = classNames.map(() => ({ type: "", count: 0, selfSize: 0, retainedSize: 0 }));
  let totalSelfSize = 0, reachableSelfSize = 0;
  for (let node = 0; node < nodeCount; node++) {
    const row = rows[nodeClass[node]!]!;
    row.count++; row.selfSize += selfSize[node]!; totalSelfSize += selfSize[node]!;
    if (visited[node]) reachableSelfSize += selfSize[node]!;
    else row.retainedSize += selfSize[node]!; // unreachable from the root: it retains itself
  }

  // Walk the dominator tree; an instance counts toward its type when no ancestor shares the type.
  const firstChild = new Uint32Array(reachableCount + 1);
  for (let index = 0; index < rootIndex; index++) firstChild[dominator[index]! + 1]!++;
  for (let index = 0; index < reachableCount; index++) firstChild[index + 1]! += firstChild[index]!;
  const children = new Uint32Array(Math.max(0, rootIndex));
  const childFill = firstChild.slice(0, reachableCount);
  for (let index = 0; index < rootIndex; index++) children[childFill[dominator[index]!]!++] = index;
  const open = new Uint32Array(classNames.length);
  const walkNode = stackNode, walkChild = stackEdge;
  depth = 0;
  const enter = (index: number) => {
    const id = nodeClass[postNode[index]!]!;
    if (open[id] === 0) rows[id]!.retainedSize += retained[index]!;
    open[id]!++;
    walkNode[depth] = index; walkChild[depth] = firstChild[index]!; depth++;
  };
  if (reachableCount > 0) enter(rootIndex);
  while (depth > 0) {
    const index = walkNode[depth - 1]!;
    const child = walkChild[depth - 1]!;
    if (child < firstChild[index + 1]!) { walkChild[depth - 1] = child + 1; enter(children[child]!); }
    else { open[nodeClass[postNode[index]!]!]!--; depth--; }
  }

  // The largest single retainers below the root, and the edge their dominator holds each by.
  const largest: number[] = [];
  const byRetained = (a: number, b: number) => retained[b]! - retained[a]!;
  for (let index = 0; index < rootIndex && topObjects > 0; index++) {
    if (graph.nodeTypes[graph.type[postNode[index]!]!] === "synthetic") continue;
    if (largest.length < topObjects) { largest.push(index); if (largest.length === topObjects) largest.sort(byRetained); continue; }
    if (retained[index]! <= retained[largest[largest.length - 1]!]!) continue;
    largest[largest.length - 1] = index;
    largest.sort(byRetained);
  }
  largest.sort(byRetained);
  const numbered = new Set(["element", "hidden"]);
  const edgesInto = (owner: number, node: number) => {
    for (let edge = firstEdge[owner]!; edge < firstEdge[owner + 1]!; edge++) {
      if (edgeTo[edge] !== node || edgeType[edge] === weak) continue;
      const edgeKind = graph.edgeTypes[edgeType[edge]!]!;
      return { owner, edgeKind, index: numbered.has(edgeKind) ? graph.edgeName[edge]! : null, nameId: numbered.has(edgeKind) ? null : graph.edgeName[edge]! };
    }
    return null;
  };
  /* The dominator's own reference when it has one; otherwise the object is
     reachable several ways, and up to three direct referrers are named. */
  const held = largest.map(index => {
    const node = postNode[index]!;
    const direct = edgesInto(postNode[dominator[index]!]!, node);
    if (direct) return [direct];
    const referrers: NonNullable<ReturnType<typeof edgesInto>>[] = [];
    for (let at = firstPredecessor[index]!; at < firstPredecessor[index + 1]! && referrers.length < 3; at++) {
      const via = edgesInto(postNode[predecessors[at]!]!, node);
      if (via && !referrers.some(known => known.owner === via.owner)) referrers.push(via);
    }
    return referrers;
  });

  const wanted = new Set<number>();
  for (const label of classLabels) if (label.nameId !== null) wanted.add(label.nameId);
  for (const via of held.flat()) if (via.nameId !== null) wanted.add(via.nameId);
  const table = strings(wanted);
  const labelOf = (label: Label) => (label.nameId !== null && table.get(label.nameId)) || `(${label.kind})`;
  /* Two string-table entries may spell the same class; their rows merge. */
  const merged = new Map<string, TypeRow>();
  const rowOfClass = rows.map((row, id) => {
    const type = labelOf(classLabels[id]!);
    const into = merged.get(type);
    if (!into) { row.type = type; merged.set(type, row); return row; }
    into.count += row.count; into.selfSize += row.selfSize; into.retainedSize += row.retainedSize;
    return into;
  });
  const objects: ObjectRow[] = largest.map((index, at) => {
    const heldBy = held[at]!.map(via => {
      const edge = via.index !== null ? `${via.edgeKind} [${via.index}]` : `${via.edgeKind} ${JSON.stringify((table.get(via.nameId!) ?? "").slice(0, 60))}`;
      return `${rowOfClass[nodeClass[via.owner]!]!.type} via ${edge}`;
    }).join("; ") || "the root";
    return { type: rowOfClass[nodeClass[postNode[index]!]!]!.type, selfSize: selfSize[postNode[index]!]!, retainedSize: retained[index]!, heldBy };
  });
  return { nodeCount, edgeCount, totalSelfSize, reachableCount, reachableSelfSize, types: [...merged.values()], objects };
}

/** Reads the file twice: the graph, then only the strings the answer names. */
export function analyzeHeapSnapshot(file: string, topObjects = 30): HeapSnapshotSummary {
  return summarizeHeapSnapshot(readHeapSnapshot(file), wanted => readHeapSnapshotStrings(file, wanted), topObjects);
}

function human(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function table(title: string, rows: TypeRow[]): string {
  const lines = [title, `${"count".padStart(12)} ${"self".padStart(12)} ${"retained".padStart(12)}  type`];
  for (const row of rows) {
    lines.push(`${String(row.count).padStart(12)} ${human(row.selfSize).padStart(12)} ${human(row.retainedSize).padStart(12)}  ${row.type.slice(0, 80)}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const file = args.find(arg => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--top");
  const top = Number(args[args.indexOf("--top") + 1]) > 0 && args.includes("--top") ? Number(args[args.indexOf("--top") + 1]) : 30;
  if (!file) {
    console.error("usage: bun scripts/heap-snapshot-top.ts <file.heapsnapshot> [--top 30] [--json]");
    process.exit(2);
  }
  const started = performance.now();
  const summary = analyzeHeapSnapshot(file, top);
  // The synthetic root retains everything; it says nothing about an owner.
  const types = summary.types.filter(row => row.type !== "(synthetic)");
  const byCount = [...types].sort((a, b) => b.count - a.count).slice(0, top);
  const byRetained = [...types].sort((a, b) => b.retainedSize - a.retainedSize).slice(0, top);
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ...summary, types: undefined, byCount, byRetained }));
  } else {
    console.log(`nodes ${summary.nodeCount}, edges ${summary.edgeCount}, self size ${human(summary.totalSelfSize)}`);
    console.log(`reachable from the root: ${summary.reachableCount} nodes, ${human(summary.reachableSelfSize)}`);
    console.log(`\n${table(`Top ${byCount.length} types by count`, byCount)}`);
    console.log(`\n${table(`Top ${byRetained.length} types by retained size`, byRetained)}`);
    console.log(`\nTop ${summary.objects.length} single objects by retained size`);
    console.log(`${"self".padStart(12)} ${"retained".padStart(12)}  type, held by`);
    for (const row of summary.objects) console.log(`${human(row.selfSize).padStart(12)} ${human(row.retainedSize).padStart(12)}  ${row.type.slice(0, 60)}, held by ${row.heldBy}`);
    console.log(`\nanalysed in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
}
