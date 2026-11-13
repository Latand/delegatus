import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, statSync } from "node:fs";

export const LOOP_PROFILE_WINDOW_MS = 5000;
export const LOOP_PROFILE_ARM_MS = 30 * 60_000;
export const LOOP_PROFILE_BYTES = 8192;
const intervalUs = 10_000, sampleCap = 4096, depthCap = 32, frameCap = 128, topN = 16;
const sourceFileCap = 8, sourceBytesCap = 2 * 1024 * 1024, sourceFileBytesCap = 1024 * 1024;
type Frame = { name: string; sourceURL?: string; line: number; column: number; category?: string };
type SourceMetadata = { bytes: number; nearestNames: string[]; staticNames: Set<string> };
export type LoopProfile = { traces: { frames: Frame[] }[] };
type Summary = ReturnType<typeof trimLoopProfile>;
type Categories = ReturnType<typeof categorizeLoopProfile>;
/** A gap of two seconds or more carries named frames and the category
 * histogram; a shorter gap carries the histogram alone. */
export type LoopGapProfile = { status: "captured"; from: number; to: number; intervalUs: number; frames?: Summary; categories?: Categories }
  | { status: "unavailable" | "not-armed" | "skipped"; reason: string };
/** Shortest gap that gets a category histogram; named frames need LOOP_PROFILE_FRAMES_GAP_MS. */
export const LOOP_PROFILE_GAP_MS = 500;
export const LOOP_PROFILE_FRAMES_GAP_MS = 2000;
type Emit = (profile: LoopGapProfile) => void;

/** Runtime names can come from computed property keys. Require cached source
 * metadata to declare the name before it crosses the logging boundary. */
function location(frame: Frame, root: string, sources: Map<string, SourceMetadata | null>) {
  const { line, column } = frame;
  if (!frame.sourceURL || frame.sourceURL.length > 1024 || !/^[A-Za-z_$][\w$]{0,95}$/.test(frame.name)
    || !Number.isSafeInteger(line) || line < 1 || line === 4294967295
    || !Number.isSafeInteger(column) || column < 1 || column === 4294967295) return null;
  let source = frame.sourceURL;
  if (source.startsWith("file:")) {
    try { const url = new URL(source); if (url.search || url.hash || url.host) return null; source = fileURLToPath(url); }
    catch { return null; }
  }
  if (!path.isAbsolute(source)) return null;
  const file = path.relative(root, source).split(path.sep).join("/");
  const sourceFile = /^(?:src|scripts)\/[\w./-]+\.[cm]?[jt]sx?$/.test(file);
  const emittedViewerFile = /^\.next\/server\/[\w./-]+\.[cm]?js$/.test(file);
  if ((!sourceFile && !emittedViewerFile)
    || file.split("/").some(part => part === ".." || part === "node_modules")) return null;
  const sourcePath = path.resolve(root, file);
  let metadata = sources.get(file);
  if (metadata === undefined) {
    if (sources.size >= sourceFileCap) return null;
    try {
      const size = statSync(sourcePath).size;
      const used = [...sources.values()].reduce((total, value) => total + (value?.bytes ?? 0), 0);
      if (size > sourceFileBytesCap || used + size > sourceBytesCap) metadata = null;
      else metadata = buildSourceMetadata(readFileSync(sourcePath, "utf8"), emittedViewerFile);
    } catch { metadata = null; }
    sources.set(file, metadata);
  }
  if (!metadata || !(emittedViewerFile
    ? metadata.staticNames.has(frame.name)
    : metadata.nearestNames[line - 1] === frame.name)) return null;
  return { function: frame.name, file, line, column };
}

function buildSourceMetadata(text: string, emitted: boolean): SourceMetadata {
  const lines = text.split("\n");
  const nearestNames = new Array<string>(lines.length);
  const declarations: { line: number; name: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index]!;
    const declaration = current.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/);
    const method = current.match(/(?:^|[,{;]\s*)(?:\[([^\]]+)\]|([A-Za-z_$][\w$]*))\s*\([^)]*\)\s*\{/);
    const arrow = current.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/);
    const name = declaration?.[1] ?? method?.[2] ?? arrow?.[1];
    if (name) declarations.push({ line: index + 1, name });
  }
  let currentName: string | undefined, declarationIndex = 0;
  for (let index = 0; index < lines.length; index++) {
    while (declarationIndex < declarations.length && declarations[declarationIndex]!.line <= index + 1) {
      currentName = declarations[declarationIndex++]!.name;
    }
    if (currentName) nearestNames[index] = currentName;
  }
  const staticNames = new Set<string>();
  if (emitted) {
    for (const pattern of [
      /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
      /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function\b/g,
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    ]) {
      for (const match of text.matchAll(pattern)) staticNames.add(match[1]!);
    }
  }
  return { bytes: Buffer.byteLength(text), nearestNames, staticNames };
}

/* Names of built-in functions the engine runs natively. A sampled leaf is
 * reported under its name only when the name is in this list; every other
 * native leaf is counted as "other". The list is the whole vocabulary of
 * native names that can reach the journal. */
const nativeNames = new Set([
  "structuredClone", "parse", "stringify", "all", "get", "run", "values", "iterate", "exec", "prepare", "query",
  "split", "replace", "replaceAll", "match", "matchAll", "test", "search", "toLowerCase", "toUpperCase", "normalize",
  "localeCompare", "slice", "substring", "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith", "trim", "join",
  "concat", "repeat", "padStart", "charCodeAt", "codePointAt", "sort", "map", "filter", "forEach", "reduce", "flatMap",
  "flat", "find", "findIndex", "some", "every", "push", "splice", "reverse", "fill", "from", "of", "isArray", "keys",
  "entries", "fromEntries", "assign", "freeze", "isFrozen", "defineProperty", "defineProperties",
  "getOwnPropertyDescriptor", "getOwnPropertyNames", "getPrototypeOf", "setPrototypeOf", "create", "hasOwn",
  "hasOwnProperty", "ownKeys", "apply", "call", "bind", "construct", "set", "has", "add", "delete", "clear", "Map",
  "Set", "WeakMap", "Proxy", "Date", "now", "toISOString", "toString", "toFixed", "Number", "String", "Boolean",
  "Object", "Array", "Error", "RegExp", "Promise", "then", "resolve", "cloneObject", "byteLength", "alloc", "toJSON",
  "encode", "decode", "write", "end", "readFileSync", "writeFileSync", "statSync", "lstatSync", "existsSync",
  "readdirSync", "openSync", "readSync", "closeSync", "renameSync", "mkdirSync", "rmSync", "realpathSync", "digest",
  "update", "createHash", "randomUUID", "randomBytes", "setTimeout", "clearTimeout", "setImmediate", "queueMicrotask",
  "nextTick", "emit", "fetch", "json", "text", "enqueue", "close", "gc", "deepEquals", "inspect", "isDeepStrictEqual",
]);
const nativeRows = 12, fileRows = 8, callerRows = 3, callerNatives = 4;
/* One name, several built-ins: a SQLite statement, a Map, a Promise. Their
 * callers tell them apart, so these keep their callers whatever their rank. */
const sharedNames = new Set(["all", "get", "run", "set", "has", "values", "parse", "exec"]);

/** A repository-relative emitted chunk or source file, or null. Never a path outside the serving root. */
function safeFile(sourceURL: string | undefined, root: string, known: Map<string, string | null>) {
  if (!sourceURL || sourceURL.length > 1024) return null;
  let held = known.get(sourceURL);
  if (held !== undefined) return held;
  held = null;
  let source = sourceURL;
  try {
    if (source.startsWith("file:")) { const url = new URL(source); source = url.search || url.hash || url.host ? "" : fileURLToPath(url); }
    if (path.isAbsolute(source)) {
      const file = path.relative(root, source).split(path.sep).join("/");
      // Route folders carry dynamic segments and groups: `[id]`, `(group)`.
      if ((/^(?:src|scripts)\/[\w./()[\]-]+\.[cm]?[jt]sx?$/.test(file) || /^\.next\/server\/[\w./()[\]-]+\.[cm]?js$/.test(file))
        && !file.split("/").some(part => part === ".." || part === "node_modules")) held = file;
    }
  } catch { held = null; }
  if (known.size < 4096) known.set(sourceURL, held);
  return held;
}

const runtimeModuleSource = /^(?:bun|node):|^builtin:\/\//;

/**
 * Where the sampled time went, by the leaf of each sample: a native function
 * from the fixed list, a regular expression, or the file of the script that
 * was running. For the busiest native functions it adds the positions of the
 * script frames that called them. One bounded pass, no source file is read.
 * A regular expression's text, a computed name and a path outside the serving
 * root never appear: they are counted as "regexp", "other" and "elsewhere".
 */
export function categorizeLoopProfile(raw: LoopProfile, root: string) {
  const count = Math.min(sampleCap, raw.traces.length);
  const native = new Map<string, number>(), files = new Map<string, number>();
  const callers = new Map<string, Map<string, number>>();
  const known = new Map<string, string | null>();
  let regexp = 0, script = 0, empty = 0;
  for (let i = 0; i < count; i++) {
    const frames = raw.traces[Math.floor(i * raw.traces.length / count)]!.frames;
    const leaf = frames[0];
    if (!leaf) { empty++; continue; }
    if (leaf.category === "RegExp" || (typeof leaf.name === "string" && leaf.name.startsWith("/"))) { regexp++; continue; }
    if (leaf.sourceURL) {
      script++;
      const file = safeFile(leaf.sourceURL, root, known) ?? "elsewhere";
      files.set(file, (files.get(file) ?? 0) + 1);
      continue;
    }
    const name = typeof leaf.name === "string" && nativeNames.has(leaf.name) ? leaf.name : "other";
    native.set(name, (native.get(name) ?? 0) + 1);
    // The nearest script frame names the caller of this native work. Bun's
    // own modules (`bun:sqlite` wraps prepare and run) are passed over: the
    // statement that matters is the repository frame that called into them.
    let position: string | undefined, runtimeModule = false;
    for (let depth = 1; depth < Math.min(depthCap, frames.length); depth++) {
      const caller = frames[depth]!;
      if (!caller.sourceURL) continue;
      if (runtimeModuleSource.test(caller.sourceURL)) { runtimeModule = true; continue; }
      const file = safeFile(caller.sourceURL, root, known);
      position = file && Number.isSafeInteger(caller.line) && caller.line > 0 && caller.line !== 4294967295
        && Number.isSafeInteger(caller.column) && caller.column > 0 && caller.column !== 4294967295
        ? `${file}:${caller.line}:${caller.column}` : file ?? "elsewhere";
      break;
    }
    if (position === undefined && runtimeModule) position = "elsewhere";
    if (position !== undefined) {
      let held = callers.get(name);
      if (!held) callers.set(name, held = new Map());
      if (held.has(position) || held.size < 256) held.set(position, (held.get(position) ?? 0) + 1);
    }
  }
  const top = (rows: Map<string, number>, limit: number) =>
    [...rows].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
  const nativeTop = top(native, nativeRows);
  const result = { samples: raw.traces.length, inspectedSamples: count, native: nativeTop, regexp, script, empty,
    files: top(files, fileRows),
    callers: nativeTop.filter(([name], rank) => (rank < callerNatives || sharedNames.has(name)) && callers.has(name))
      .map(([name]) => ({ native: name, positions: top(callers.get(name)!, callerRows) })) };
  // Positions are the longest part: drop them first, then file rows.
  while (Buffer.byteLength(JSON.stringify(result)) > 2048 && result.callers.length) result.callers.pop();
  while (Buffer.byteLength(JSON.stringify(result)) > 2048 && result.files.length) result.files.pop();
  return result;
}

/** Conversion has a fixed visit/allocation budget even when native collection
 * was unbounded. Even spacing covers the whole window; weights use visited
 * samples, including samples whose frames privacy filtering omitted. */
export function trimLoopProfile(raw: LoopProfile, root: string) {
  const sources = new Map<string, SourceMetadata | null>();
  const frames = new Map<string, { function: string; file: string; line: number; column: number; self: number; total: number }>();
  const count = Math.min(sampleCap, raw.traces.length);
  // Misra-Gries candidates let a hot function arriving late displace earlier
  // one-off frames. Decrements consume prior increments, bounding total work.
  const candidates = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const trace = raw.traces[Math.floor(i * raw.traces.length / count)]!;
    const seen = new Set<string>();
    for (let depth = 0; depth < Math.min(depthCap, trace.frames.length); depth++) {
      const frame = location(trace.frames[depth]!, root, sources);
      if (!frame) continue;
      const key = `${frame.file}:${frame.line}:${frame.column}:${frame.function}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (candidates.has(key)) candidates.set(key, candidates.get(key)! + 1);
      else if (candidates.size < frameCap) candidates.set(key, 1);
      else for (const [candidate, weight] of candidates) {
        if (weight === 1) candidates.delete(candidate); else candidates.set(candidate, weight - 1);
      }
    }
  }
  // Count exact self/total weights for the surviving candidates in a second
  // bounded pass. Candidate elimination itself never fabricates weights.
  for (let i = 0; i < count; i++) {
    const trace = raw.traces[Math.floor(i * raw.traces.length / count)]!;
    const seen = new Set<string>();
    for (let depth = 0; depth < Math.min(depthCap, trace.frames.length); depth++) {
      const frame = location(trace.frames[depth]!, root, sources);
      if (!frame) continue;
      const key = `${frame.file}:${frame.line}:${frame.column}:${frame.function}`;
      if (!candidates.has(key)) continue;
      let row = frames.get(key);
      if (!row && frames.size < frameCap) { row = { ...frame, self: 0, total: 0 }; frames.set(key, row); }
      if (!row) continue;
      if (depth === 0) row.self++;
      if (!seen.has(key)) row.total++;
      seen.add(key);
    }
  }
  const rank = (a: { self: number; total: number; file: string; line: number; column: number; function: string }, b: typeof a) =>
    b.self - a.self || b.total - a.total || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.function.localeCompare(b.function);
  const rows = [...frames.values()].sort(rank).slice(0, topN).map(row => ({ ...row,
    selfWeight: row.self / (count || 1), totalWeight: row.total / (count || 1) }));
  const result = { samples: raw.traces.length, inspectedSamples: count, sampleCap, depthCap, frameCap, topN, rows };
  // Reserve space for the enclosing window metadata too. Count UTF-8 bytes.
  while (Buffer.byteLength(JSON.stringify(result)) > LOOP_PROFILE_BYTES - 512 && rows.length) rows.pop();
  return result;
}

export interface LoopProfilerPorts {
  now(): number;
  enabled(): Promise<boolean>;
  collect(work: () => Promise<void>, intervalUs: number): Promise<{ stackTraces: unknown }>;
  sleep(ms: number): Promise<void>;
  flushTick(): void;
  phase<T>(phase: "collect" | "trim" | "settings", work: () => T): T;
  root: string;
  completed?(profile: LoopGapProfile): void;
  beforeCollect?(): Promise<boolean>;
  /** Synchronous boundary immediately before native sampling starts. */
  captureStarted?(): void;
}

/** One owner per Viewer monitor; no runtime-host start path calls this. */
export function createLoopProfiler(ports: LoopProfilerPorts, expires: number) {
  let stopped = false, started = false;
  let window: { from: number; pending: { emit: Emit; frames: boolean }[] } | undefined;
  let inactive: LoopGapProfile = { status: "skipped", reason: "no-active-window" };
  const enabled = async () => {
    if (stopped || ports.now() >= expires) return false;
    const on = await ports.phase("settings", ports.enabled);
    if (stopped || ports.now() >= expires) return false;
    if (!on) inactive = { status: "not-armed", reason: "kill-switch" };
    return on;
  };
  const capture = async () => {
    if (!await enabled()) return false;
    const current = window = { from: ports.now(), pending: [] as { emit: Emit; frames: boolean }[] };
    try {
      if (ports.beforeCollect && !await ports.beforeCollect()) {
        inactive = { status: "not-armed", reason: "waiting-for-capture" };
        return false;
      }
      // Admission may perform durable I/O. Re-read controls after its final
      // await so a switch or stop that arrived during admission wins.
      if (!await enabled()) return false;
      ports.captureStarted?.();
      const raw = await ports.phase("collect", () => ports.collect(() => ports.sleep(Math.min(LOOP_PROFILE_WINDOW_MS, expires - ports.now())), intervalUs));
      // A profile timer can recover before the monitor's timer. Observe that
      // recovery while this window still owns its pending gap records.
      ports.flushTick();
      const to = ports.now();
      // Legacy gap-only callers discard healthy windows. An explicitly
      // admitted lifetime capture also saves its post-trigger window.
      if (current.pending.length || ports.completed) {
        // The histogram reads no source files. Named frames are requested
        // by long gaps or the explicitly admitted capture callback.
        const { categories, frames } = ports.phase("trim", () => ({
          categories: categorizeLoopProfile(raw.stackTraces as LoopProfile, ports.root),
          frames: ports.completed || current.pending.some(gap => gap.frames) ? trimLoopProfile(raw.stackTraces as LoopProfile, ports.root) : undefined,
        }));
        const record = (withFrames: boolean): LoopGapProfile => ({ status: "captured", from: current.from, to, intervalUs,
          ...(withFrames && frames ? { frames } : {}), categories });
        // Frames were cut to the whole budget on their own: make room for the histogram beside them.
        while (frames?.rows.length && Buffer.byteLength(JSON.stringify(record(true))) > LOOP_PROFILE_BYTES) frames.rows.pop();
        ports.completed?.(record(true));
        for (const gap of current.pending) gap.emit(record(gap.frames));
      }
    } catch {
      stopped = true;
      inactive = { status: "unavailable", reason: "capture-failed" };
      for (const gap of current.pending) gap.emit(inactive);
    } finally { window = undefined; }
    return true;
  };
  return {
    correlate(from: number, to: number, gapMs: number, emit: Emit) {
      if (gapMs < LOOP_PROFILE_GAP_MS) return false;
      const frames = gapMs >= LOOP_PROFILE_FRAMES_GAP_MS;
      // Every qualifying gap gets either this window's result or an immediate
      // explanation. Reasons are fixed labels, never native error text.
      // A short gap with no window to join is logged as before, without a profile field.
      if (!window) {
        if (!frames) return false;
        emit(!stopped && ports.now() >= expires ? { status: "not-armed", reason: "arm-expired" } : inactive);
        return true;
      }
      if (to < window.from || from > ports.now()) {
        if (!frames) return false;
        emit({ status: "skipped", reason: "outside-window" });
        return true;
      }
      // Four long gaps and eight short ones per window bound what one capture feeds.
      if (window.pending.filter(gap => gap.frames === frames).length >= (frames ? 4 : 8)) {
        emit({ status: "skipped", reason: "pending-limit" });
        return true;
      }
      window.pending.push({ emit, frames });
      return true;
    },
    async start() {
      if (started) return;
      started = true;
      while (!stopped && ports.now() < expires) {
        // Recheck the kill switch at each boundary and keep sampling bursts.
        if (!await capture()) break;
      }
    },
    stop() { stopped = true; inactive = { status: "not-armed", reason: "stopped" }; },
  };
}
