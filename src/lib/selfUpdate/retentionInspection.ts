import fs from "node:fs";
import path from "node:path";
import { performanceSpans } from "@/lib/performanceSpans";
import type { ProcessScan } from "@/lib/tempSweep";

export type RetentionUncertainty = { pid: number; reason: string; roots: string[] };
export type RetentionScan = ProcessScan & { complete: true; uncertain?: RetentionUncertainty[] };

const inside = (entry: string, root: string) => entry === root || entry.startsWith(root === path.sep ? root : root + path.sep);
/** Keep the proc observer's import graph free of stateful sweep modules.
 * Resolve the existing prefix of a path, retaining any missing suffix. */
function resolvePhysicalPath(candidate: string): string {
  const original = path.resolve(candidate); let current = original; const suffix: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...suffix); }
    catch {
      const parent = path.dirname(current);
      if (parent === current) return original;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}
/** This process's initial environment, read while its /proc files are its
 * own: sealed for a removal, they belong to root and environ is unreadable. */
const OWN_ENVIRON = (() => { try { return fs.readFileSync("/proc/self/environ", "utf8"); } catch { return null; } })();
const fields = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
const exited = (stat: string) => ["Z", "X", "x"].includes(fields(stat)[0]!);
const unescapeMount = (value: string) => value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
function mountTable(file: string) {
  return fs.readFileSync(file, "utf8").trim().split("\n").map(line => {
    const parts = line.split(" ");
    if (!parts[2] || !parts[3] || !parts[4]?.startsWith("/")
      || !parts[3].startsWith("/") && !/^(?:net|mnt|pid|uts|ipc|user|cgroup|time):\[\d+\]$/.test(parts[3])) throw new Error("invalid mount inventory");
    return { device: parts[2], root: unescapeMount(parts[3]), point: unescapeMount(parts[4]) };
  }).sort((a, b) => b.point.length - a.point.length);
}

/** Environment names Delegatus gives the processes it starts. */
const DELEGATUS_ENVIRONMENT = /^(?:LLV|DELEGATUS)_/;
/** PF_KTHREAD in the flags field of /proc/<pid>/stat. */
const KERNEL_THREAD = 0x200000;

/** An inventory records uncertainty instead of discarding every keep decision.
 * Missing evidence has installation-wide scope: a different UID or a private
 * ancestor cannot exclude files inherited before a credential change.
 *
 * A process whose links procfs refuses to show (EACCES or EPERM: another
 * user, or a nondumpable process after a credential change) is judged after
 * the inventory from what procfs shows every user: its stat, cgroup and
 * command line. It keeps that scope unless that evidence rules out every way
 * it can hold a release. A process holds a release because it opened it, or
 * because it inherited a working directory, file or mapping from the process
 * that forked it. Delegatus starts every process that runs from a release,
 * and those processes are readable. So a refused process is ruled out when it
 * is a kernel thread, or when its command line is readable and names nothing
 * under the root, and no ancestor is a Delegatus process (a readable process
 * with a Delegatus environment or with a path under the root). A process, or
 * a refused ancestor, whose session leader is neither itself nor one of its
 * ancestors may have lost the parent that forked it; it is ruled out only
 * when it also shares no cgroup with a Delegatus process it did not start,
 * because an orphan stays in its parent's cgroup. A broken ancestor chain
 * keeps it. */
export function retentionProcessScan(root: string, procRoot = "/proc", only?: number): RetentionScan {
  const processes: ProcessScan["processes"] = [];
  const uncertain: RetentionUncertainty[] = [];
  const refused: { pid: number; reason: string }[] = [];
  const readable = new Set<number>();
  const delegatus = new Set<number>();
  const ownNamespace = fs.readlinkSync(path.join(procRoot, "self/ns/mnt"));
  if (!ownNamespace) throw new Error("missing retention mount namespace");
  const physical = new Map<string, string>();
  const relevant = (entry: string) => {
    const target = entry.replace(/ \(deleted\)$/, "");
    if (inside(target, root)) return true;
    let resolved = physical.get(target);
    if (resolved === undefined) { resolved = resolvePhysicalPath(target); physical.set(target, resolved); }
    return inside(resolved, root);
  };
  let ownMounts: ReturnType<typeof mountTable> | undefined;
  for (const name of fs.readdirSync(procRoot).sort()) {
    if (!/^\d+$/.test(name) || only !== undefined && name !== String(only)) continue;
    const base = path.join(procRoot, name);
    const paths: string[] = []; const references: string[] = [];
    let namespace = ownNamespace; let operation = "stat";
    let marked = false; let complete = false;
    const read = (file: string) => { operation = file; return fs.readFileSync(path.join(base, file), "utf8"); };
    const link = (file: string) => { operation = file; return fs.readlinkSync(path.join(base, file)); };
    try {
      const before = read("stat");
      if (exited(before)) continue;
      const kernel = (Number(fields(before)[6]) & 0x200000) !== 0;
      namespace = link("ns/mnt");
      for (const file of ["cwd", "exe", "root"]) {
        try { paths.push(link(file)); }
        catch (error) { if (!(kernel && file === "exe" && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error; }
      }
      operation = "fd";
      for (const fd of fs.readdirSync(path.join(base, "fd"))) {
        try { paths.push(link("fd/" + fd)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      references.push(...read("cmdline").split("\0"));
      paths.push(...references.filter(value => value.startsWith("/")));
      for (const line of read("maps").split("\n")) {
        const target = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/.*)$/.exec(line)?.[1];
        if (target) paths.push(target);
      }
      let environment = "";
      try { environment = read("environ"); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" && Number(name) === process.pid && OWN_ENVIRON !== null) environment = OWN_ENVIRON;
        else if (!(kernel && code === "ESRCH")) throw error;
      }
      for (const pair of environment.split("\0")) {
        const equals = pair.indexOf("=");
        if (equals > 0) { const value = pair.slice(equals + 1); references.push(value); if (value.startsWith("/")) paths.push(value); }
        if (equals > 0 && DELEGATUS_ENVIRONMENT.test(pair)) marked = true;
      }
      if (namespace !== ownNamespace) {
        operation = "mountinfo";
        ownMounts ??= mountTable(path.join(procRoot, "self/mountinfo"));
        const mounts = mountTable(path.join(base, "mountinfo"));
        // Bind mounts can name a release /app, with no release prefix in argv.
        for (const entry of paths.filter(value => value.startsWith("/"))) {
          const target = entry.replace(/ \(deleted\)$/, "");
          const visible = mounts.find(row => inside(target, row.point));
          if (!visible) throw new Error("path missing from mount inventory");
          // Stacked mounts at one point retain every plausible file origin.
          for (const mount of mounts.filter(row => row.point === visible.point)) {
            // nsfs bind mounts name a namespace handle, never a release file.
            if (!mount.root.startsWith("/")) continue;
            const relative = path.join(mount.root, path.relative(mount.point, target));
            for (const host of ownMounts.filter(row => row.device === mount.device && inside(relative, row.root)))
              paths.push(path.join(host.point, path.relative(host.root, relative)));
          }
        }
      }
      const after = read("stat");
      if (fields(after)[19] !== fields(before)[19]) { operation = "identity"; throw new Error("process identity changed"); }
      if (exited(after)) continue;
      complete = true;
    } catch (error) {
      if (!fs.existsSync(base)) continue;
      try { if (exited(fs.readFileSync(path.join(base, "stat"), "utf8"))) continue; }
      catch { if (!fs.existsSync(base)) continue; }
      const code = (error as NodeJS.ErrnoException).code;
      const reason = `${operation}:${code ?? "unavailable"}`;
      // A single-process observation has no inventory to judge lineage against.
      if (only === undefined && (code === "EACCES" || code === "EPERM")) refused.push({ pid: Number(name), reason });
      else uncertain.push({ pid: Number(name), reason, roots: [root] });
    }
    const held = paths.filter(value => value.startsWith("/") && relevant(value));
    const refs = references.filter(value => value.includes(root));
    if (held.length || refs.length) processes.push({ pid: Number(name), namespace, stamped: false, paths: held, references: refs });
    if (complete) {
      readable.add(Number(name));
      if (marked || held.length || refs.length) delegatus.add(Number(name));
    }
  }
  if (refused.length) {
    const mayHold = refusedProcessMayHold(procRoot, readable, delegatus,
      value => value.includes(root) || value.startsWith("/") && relevant(value));
    for (const row of refused) if (mayHold(row.pid)) uncertain.push({ ...row, roots: [root] });
  }
  return { ownNamespace, processes, complete: true, uncertain };
}

type Lineage = { ppid: number; session: number; start: number; flags: number };

/** The verdict for a process procfs refused to show, from world-readable
 * evidence only. True keeps installation-wide uncertainty. */
function refusedProcessMayHold(procRoot: string, readable: ReadonlySet<number>, delegatus: ReadonlySet<number>, names: (value: string) => boolean) {
  const file = (pid: number, name: string) => fs.readFileSync(path.join(procRoot, String(pid), name), "utf8");
  const lineage = new Map<number, Lineage | null>();
  const observe = (pid: number): Lineage | null => {
    if (lineage.has(pid)) return lineage.get(pid)!;
    let row: Lineage | null = null;
    try {
      const values = fields(file(pid, "stat"));
      const ppid = Number(values[1]), session = Number(values[3]), start = Number(values[19]), flags = Number(values[6]);
      if ([ppid, session, flags].every(value => Number.isSafeInteger(value) && value >= 0) && Number.isFinite(start)) row = { ppid, session, start, flags };
    } catch { /* Exited or hidden: callers treat absence as a broken chain. */ }
    lineage.set(pid, row);
    return row;
  };
  const cgroups = new Map<number, string | null>();
  const cgroup = (pid: number) => {
    if (!cgroups.has(pid)) {
      let value: string | null = null;
      try { value = file(pid, "cgroup") || null; } catch { /* Unknown membership ties, below. */ }
      cgroups.set(pid, value);
    }
    return cgroups.get(pid)!;
  };
  /** Strict ancestors, nearest first; null when the chain cannot be proven. */
  const chains = new Map<number, number[] | null>();
  const ancestry = (pid: number): number[] | null => {
    if (chains.has(pid)) return chains.get(pid)!;
    const chain: number[] = [];
    let child = observe(pid);
    let result: number[] | null = child ? chain : null;
    while (child && child.ppid > 0) {
      const parent = observe(child.ppid);
      // A parent younger than its child is a reused PID.
      if (!parent || parent.start > child.start || chain.includes(child.ppid) || chain.length > 4096) { result = null; break; }
      chain.push(child.ppid);
      child = parent;
    }
    chains.set(pid, result);
    return result;
  };
  let groups: Map<string, number[]> | undefined;
  /** A process lost the parent that forked it, as far as procfs can tell,
   * when its session leader is neither itself nor one of its ancestors. Such
   * an orphan is tied to the cgroup it inherited: it shares one with a
   * Delegatus process it did not start. A login's own processes (sshd leads
   * its session, as does each service) are judged by their ancestry alone. */
  const orphanInDelegatusGroup = (pid: number) => {
    const own = observe(pid);
    const chain = ancestry(pid);
    if (!own || !chain) return true;
    if (own.session === pid || chain.includes(own.session)) return false;
    const group = cgroup(pid);
    if (!group) return true;
    if (!groups) {
      groups = new Map();
      for (const member of delegatus) {
        const key = cgroup(member);
        if (key) groups.set(key, [...groups.get(key) ?? [], member]);
      }
    }
    return (groups.get(group) ?? []).some(other => other !== pid && !(ancestry(other)?.includes(pid) ?? false));
  };
  return (pid: number) => {
    const own = observe(pid);
    if (!own) return fs.existsSync(path.join(procRoot, String(pid)));
    if ((own.flags & KERNEL_THREAD) !== 0) return false;
    let argv: string[];
    try { argv = file(pid, "cmdline").split("\0"); }
    catch { return true; }
    if (argv.some(names)) return true;
    const chain = ancestry(pid);
    if (!chain || orphanInDelegatusGroup(pid)) return true;
    return chain.some(ancestor => delegatus.has(ancestor) || !readable.has(ancestor) && orphanInDelegatusGroup(ancestor));
  };
}

/** While retention removes a tree it seals its own /proc links, so a helper
 * scan cannot read this process and records it as uncertain. The process
 * observes itself instead: its own links stay readable to it. */
export function withSelfObservation<T extends ProcessScan & { uncertain?: RetentionUncertainty[] }>(scan: T, root: string, procRoot = "/proc"): T {
  if (!scan.uncertain?.some(row => row.pid === process.pid)) return scan;
  const own = retentionProcessScan(root, procRoot, process.pid);
  return { ...scan, processes: [...scan.processes.filter(proc => proc.pid !== process.pid), ...own.processes],
    uncertain: [...scan.uncertain.filter(row => row.pid !== process.pid), ...own.uncertain ?? []] };
}

/** Validate both the ordinary helper reply and the optional proc observer's
 * reply. Unknown or empty uncertainty scopes cannot authorize deletion. */
export function validRetentionScan(value: unknown): value is RetentionScan {
  const scan = value as RetentionScan | undefined;
  return !!scan && scan.complete === true && typeof scan.ownNamespace === "string" && !!scan.ownNamespace
    && Array.isArray(scan.processes) && scan.processes.every(proc => Number.isSafeInteger(proc.pid) && proc.pid > 0
      && typeof proc.namespace === "string" && Array.isArray(proc.paths) && proc.paths.every(entry => typeof entry === "string")
      && Array.isArray(proc.references) && proc.references.every(entry => typeof entry === "string"))
    && (scan.uncertain === undefined || Array.isArray(scan.uncertain) && scan.uncertain.every(row =>
      Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.reason === "string" && !!row.reason
      && Array.isArray(row.roots) && row.roots.length > 0 && row.roots.every(root => typeof root === "string" && path.isAbsolute(root))));
}

/** Called only in the leased helper. A refused observer preserves the original
 * uncertainty; it never turns a partial observation into permission to prune. */
export function retentionScanWithObserver(root: string, observe: () => unknown, procRoot = "/proc"): RetentionScan {
  const scan = retentionProcessScan(root, procRoot);
  if (!scan.uncertain?.length) return scan;
  try {
    const observed = observe();
    if (validRetentionScan(observed)) return observed;
  } catch { /* The original per-process reasons remain authoritative. */ }
  return scan;
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
