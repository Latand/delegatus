import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { heapAttribution, type ProcessMetadata } from "./heapAttribution";

type ProcessObject = object & {
  pid?: number; exitCode?: number | null; signalCode?: string | null;
  exited?: Promise<number>;
  once?: (event: string, listener: (code: number | null, signal?: string | null) => void) => unknown;
};
type Status = { installed: string[]; errors: number };
const shared = process as typeof process & { __delegatusProcessAttribution?: Status };

// Kept outside the wrapper's activation: no reaction can close over argv or
// its target through the wrapper's lexical environment.
function exitObserver(meta: ProcessMetadata) {
  return (code: number | null, signal?: string | null) => { meta.exitedAt = Date.now(); meta.exitCode = code; meta.signal = signal ?? null; };
}

function observe(target: ProcessObject, api: string, command: string, startedAt: number, status: Status) {
  try {
    if (heapAttribution.processes.has(target)) return;
    const sync = api === "Bun.spawnSync";
    const meta: ProcessMetadata = { api, site: heapAttribution.site(new Error().stack ?? ""), command,
      pid: target.pid ?? null, startedAt, exitedAt: sync || target.pid == null ? Date.now() : null,
      exitCode: target.exitCode ?? null, signal: target.signalCode ?? null };
    if (heapAttribution.processes.add(target, meta) && !sync) {
      const exit = exitObserver(meta);
      if (api.startsWith("Bun.")) void target.exited?.then(exit, () => exit(null));
      else target.once?.("exit", exit);
    }
  } catch { status.errors++; }
}

/** Install before the Viewer graph loads. Node's prototype fallback also
 * covers Bun ESM named imports: Bun's syncBuiltinESMExports is a no-op. */
export function installProcessAttribution() {
  if (shared.__delegatusProcessAttribution) return shared.__delegatusProcessAttribution;
  const status = shared.__delegatusProcessAttribution = { installed: [] as string[], errors: 0 };
  let nodeApi: string | undefined;
  const wrap = (owner: Record<string, unknown>, name: string, api: string, prototype = false) => {
    const original = owner[name];
    if (typeof original !== "function") return;
    function attributed(this: unknown, ...args: unknown[]) {
      const startedAt = Date.now();
      const previousApi = nodeApi;
      if (api.startsWith("node.") && !prototype) nodeApi = api;
      try {
        const result = Reflect.apply(original as (...args: unknown[]) => unknown, this, args);
        try {
          const first = args[0];
          // exec's input is shell source; only retain a constant label.
          const executable = prototype ? (first as { file?: string })?.file
            : Array.isArray(first) ? first[0]
            : typeof first === "object" && first !== null ? (first as { cmd?: string[] }).cmd?.[0] : first;
          const command = name === "exec" ? "shell" : name === "fork" ? path.basename(process.execPath)
            : path.basename(typeof executable === "string" ? executable : "unknown").slice(0, 80);
          observe((prototype ? this : result) as ProcessObject, prototype ? nodeApi ?? "node.spawn" : api, command, startedAt, status);
        } catch { status.errors++; }
        return result;
      } finally { nodeApi = previousApi; }
    }
    // Preserve native custom promisify and other own function properties.
    // The prototype fallback observes launches performed by lexical natives.
    for (const key of Reflect.ownKeys(original)) {
      if (["length", "name", "prototype", "caller", "arguments"].includes(String(key))) continue;
      Object.defineProperty(attributed, key, Object.getOwnPropertyDescriptor(original, key)!);
    }
    try { owner[name] = attributed; status.installed.push(api); }
    catch { status.errors++; }
  };
  const bun = (globalThis as unknown as { Bun?: Record<string, unknown> }).Bun;
  if (bun) for (const name of ["spawn", "spawnSync"]) wrap(bun, name, `Bun.${name}`);
  const childProcess = createRequire(import.meta.url)("node:child_process") as Record<string, unknown> & { ChildProcess: { prototype: Record<string, unknown> } };
  wrap(childProcess.ChildProcess.prototype, "spawn", "node.ChildProcess.spawn", true);
  for (const name of ["spawn", "execFile", "exec", "fork"]) wrap(childProcess, name, `node.${name}`);
  syncBuiltinESMExports();
  return status;
}

export const processAttributionStatus = () => shared.__delegatusProcessAttribution ?? { installed: [], errors: 0 };
