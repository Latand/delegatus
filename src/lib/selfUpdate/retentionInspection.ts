import fs from "node:fs";
import path from "node:path";
import { performanceSpans } from "@/lib/performanceSpans";
import { resolvePhysicalPath, type ProcessScan } from "@/lib/tempSweep";

export type RetentionScan = ProcessScan & { complete: true };
/** A partial observation cannot authorize removal. Only vanished processes and
 * processes belonging to another uid may be omitted from a private release root. */
export function retentionProcessScan(root: string, procRoot = "/proc"): RetentionScan {
  const processes: ProcessScan["processes"] = [];
  const ownNamespace = fs.readlinkSync(path.join(procRoot, "self/ns/mnt"));
  const physical = new Map<string, string>();
  const relevant = (entry: string) => {
    const target = entry.replace(/ \(deleted\)$/, "");
    if (target === root || target.startsWith(root + path.sep)) return true;
    let resolved = physical.get(target);
    if (resolved === undefined) { resolved = resolvePhysicalPath(target); physical.set(target, resolved); }
    return resolved === root || resolved.startsWith(root + path.sep);
  };
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const base = path.join(procRoot, name);
    try {
      if (fs.statSync(base).uid !== process.getuid?.()) continue;
      const before = fs.readFileSync(path.join(base, "stat"), "utf8");
      const fields = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (["Z", "X"].includes(fields(before)[0]!)) continue;
      const namespace = fs.readlinkSync(path.join(base, "ns/mnt"));
      const paths: string[] = [];
      for (const link of ["cwd", "exe", "root"]) paths.push(fs.readlinkSync(path.join(base, link)));
      for (const fd of fs.readdirSync(path.join(base, "fd"))) {
        try { paths.push(fs.readlinkSync(path.join(base, "fd", fd))); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const references = fs.readFileSync(path.join(base, "cmdline"), "utf8").split("\0");
      paths.push(...references.filter(value => value.startsWith("/")));
      for (const line of fs.readFileSync(path.join(base, "maps"), "utf8").split("\n")) {
        const target = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];
        if (target) paths.push(target);
      }
      for (const pair of fs.readFileSync(path.join(base, "environ"), "utf8").split("\0")) {
        const equals = pair.indexOf("=");
        if (equals > 0) { const value = pair.slice(equals + 1); references.push(value); if (value.startsWith("/")) paths.push(value); }
      }
      const after = fields(fs.readFileSync(path.join(base, "stat"), "utf8"));
      if (after[19] !== fields(before)[19]) throw new Error("process identity changed during retention scan");
      if (["Z", "X"].includes(after[0]!)) continue;
      const held = paths.filter(value => value.startsWith("/") && relevant(value));
      const refs = references.filter(value => value.includes(root));
      if (held.length || refs.length) processes.push({ pid: Number(name), namespace, stamped: false, paths: held, references: refs });
    } catch (error) {
      // A missing fd is handled above. Any other missing evidence is safe only
      // after proving this process has exited, rather than silently skipping it.
      if (!fs.existsSync(base)) continue;
      try {
        const stat = fs.readFileSync(path.join(base, "stat"), "utf8");
        if (["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!)) continue;
      } catch { if (!fs.existsSync(base)) continue; }
      throw new Error("partial retention process scan", { cause: error });
    }
  }
  return { ownNamespace, processes, complete: true };
}

/** Same allocation semantics as retention used before; incomplete walks refuse. */
export function retentionBytes(directory: string): number {
  return performanceSpans.sync("self-update.bytes", () => {
    let bytes = 0; let count = 0;
    const pending = [directory];
    const device = fs.lstatSync(directory).dev;
    while (pending.length) {
      if (++count > 200_000) throw new Error("partial retention byte count");
      const file = pending.pop()!; const stat = fs.lstatSync(file);
      if (stat.dev !== device) throw new Error("retention byte count crossed a device");
      if (stat.isDirectory()) pending.push(...fs.readdirSync(file).map(name => path.join(file, name)));
      if (stat.isDirectory() || stat.nlink === 1) bytes += stat.blocks * 512;
    }
    return bytes;
  });
}
