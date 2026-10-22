import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectTree, measureTempBytes, resolvePhysicalPath, type ProcessScan } from "@/lib/tempSweep";

const exec = promisify(execFile);
const inside = (file: string, root: string) => file === root || file.startsWith(root + path.sep);
const run = (command: string, args: string[]) => exec(command, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" });
async function repositoryLinks(directory: string): Promise<string[]> {
  if (process.platform !== "win32") return (await run("find", [directory, "-xdev", "-name", ".git", "-type", "d", "-prune", "-o", "-type", "l", "-print0"])).stdout.split("\0").filter(Boolean);
  const pending = [directory], links: string[] = []; let visited = 0;
  while (pending.length) for (const entry of await fs.promises.readdir(pending.pop()!, { withFileTypes: true })) {
    if (++visited > 200_000) throw new Error("partial inbound-link inventory");
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isSymbolicLink()) links.push(file);
    else if (entry.isDirectory() && entry.name !== ".git") pending.push(file);
  }
  return links;
}

/** A durable checkout link remains a dependency while its lane is open,
 * including between stages when no process has that checkout as its cwd. */
export async function repositoryReferencesAttemptTemp(repository: string, original: string, current = original): Promise<boolean> {
  const roots = [...new Set([original, current, resolvePhysicalPath(original), resolvePhysicalPath(current)])];
  for (const link of await repositoryLinks(repository)) {
    const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
    if ([target, resolvePhysicalPath(target)].some(target => roots.some(root => inside(target, root)))) return true;
  }
  return false;
}

/** Idle processes can still depend on a symlink in their checkout. Resolve
 * links without descending through them, including currently dangling links. */
export async function attemptReferencesClear(original: string, current: string, scan: ProcessScan): Promise<boolean> {
  if (scan.processes.some(process => process.paths.some(file => [file, resolvePhysicalPath(file)]
    .some(file => inside(file, original) || inside(file, current))))) return false;
  if (process.platform === "linux") {
    for (const line of fs.readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)) {
      const socket = line.trim().split(/\s+/).slice(7).join(" ");
      if (socket.startsWith(path.sep) && [socket, resolvePhysicalPath(socket)].some(socket => inside(socket, original) || inside(socket, current))) return false;
    }
  }
  const repositories = new Set<string>();
  for (const process of scan.processes) {
    let cwd = process.paths[0];
    if (!cwd?.startsWith(path.sep)) continue;
    for (let depth = 0; depth < 64 && cwd !== path.dirname(cwd); depth++, cwd = path.dirname(cwd)) {
      if (fs.existsSync(path.join(cwd, ".git"))) { repositories.add(cwd); break; }
    }
  }
  if (repositories.size > 32) return false;
  for (const repository of repositories) {
    if (await repositoryReferencesAttemptTemp(repository, original, current)) return false;
  }
  return process.platform !== "linux" || await containerMountsClear([original, current]);
}

async function containerMountsClear(roots: readonly string[]): Promise<boolean> {
  let active: string[];
  try { active = (await run("docker", ["ps", "-q"])).stdout.trim().split(/\s+/).filter(Boolean); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  if (active.length > 1024 || new Set(active).size !== active.length) return false;
  for (let offset = 0; offset < active.length; offset += 32) {
    const ids = active.slice(offset, offset + 32);
    // Read only ownership metadata, in bounded replies. Whole inspect output
    // also includes credentials and unrelated configuration.
    const output = (await run("docker", ["inspect", "--format", '{"Id":{{json .Id}},"Mounts":{{json .Mounts}}}', ...ids])).stdout;
    const containers = output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (containers.length !== ids.length) return false;
    if (!ids.every(id => {
      const matches = containers.filter(container => typeof container?.Id === "string" && container.Id.startsWith(id));
      if (matches.length !== 1 || !Array.isArray(matches[0].Mounts)) return false;
      return matches[0].Mounts.every((mount: { Type?: string; Source?: string }) => {
        if (mount.Type === "tmpfs") return true;
        return typeof mount.Source === "string" && path.isAbsolute(mount.Source)
          && !roots.some(root => inside(mount.Source!, root) || inside(root, mount.Source!));
      });
    })) return false;
  }
  return true;
}

const unsafe = ["(", "-name", ".delegatus-keep", "-o", "-path", "*/.git/worktrees", "-o", "-path", "*/worktrees/*/gitdir",
  "-o", "-name", ".git", "!", "-type", "d", "!", "(", "-type", "f", "-size", "0",
  "-regex", ".*/uvcache/sdists-v[0-9][0-9]*/.*", ")", ")", "-print", "-quit"];
const utilityImages = ["busybox:*", "alpine:*", "debian:*", "ubuntu:*", "postgres:*", "redis:*"];
export async function attemptTempUtilityImage(): Promise<string> {
  if (process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE) return process.env.LLV_ATTEMPT_TEMP_CLEANUP_IMAGE;
  for (const pattern of utilityImages) {
    const found = (await run("docker", ["image", "ls", "--filter", `reference=${pattern}`, "--format", "{{.ID}}"])).stdout.trim().split(/\s+/)[0];
    if (found) return found;
  }
  throw new Error("no installed container cleanup utility image");
}
async function containerCommand(directory: string, operation: "inspect" | "remove" | "measure", original = directory, guard?: () => Promise<boolean>) {
  const initial = fs.lstatSync(directory);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error("attempt namespace root changed");
  const identity = `${initial.dev}:${initial.ino}`;
  // Running containers may hold files through mount aliases that an ordinary
  // proc observer cannot read. Never stop or exec into one for reclamation.
  if (!await containerMountsClear([directory, original])) throw new Error("container ownership could not be cleared for the attempt tree");
  const image = await attemptTempUtilityImage();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image) || directory.includes(",")) throw new Error("invalid container cleanup input");
  const body = operation === "inspect" ? 'exec find /attempt -xdev "$@"'
    : operation === "measure" ? 'exec du -skx /attempt'
    : 'find /attempt -xdev "$@" > /tmp/holds || exit; test ! -s /tmp/holds || exit 75; exec find /attempt -xdev -depth -mindepth 1 -delete';
  const script = 'identity=$1; shift; test "$(stat -c %d:%i /attempt)" = "$identity" || exit 75; ' + body;
  if (guard && !await guard()) throw new Error("attempt authority changed before namespace removal");
  const final = fs.lstatSync(directory);
  if (!final.isDirectory() || final.isSymbolicLink() || `${final.dev}:${final.ino}` !== identity)
    throw new Error("attempt identity changed before namespace dispatch");
  // Only this owned tree is writable. No pull, network, socket, privileged
  // mode or host namespace is granted to the cleanup container.
  return run("docker", ["run", "--rm", "--pull=never", "--network=none", "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=1m",
    "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=128m", "--cpus=1", "--user=0",
    "--mount", `type=bind,source=${directory},target=/attempt${operation !== "remove" ? ",readonly" : ""}`,
    "--entrypoint", "timeout", image, "12", "/bin/sh", "-c", script, "sh", identity, ...unsafe]);
}

/** Native find streams an arbitrarily large owned tree; the owned worker and
 * each command impose time bounds instead of permanently retaining it at an
 * entry-count ceiling. Linked worktrees remain with their preservation owner. */
export async function inspectAttemptTree(directory: string, original = directory): Promise<boolean> {
  if (process.platform === "win32") return !inspectTree(directory, { git: "linked", threshold: Infinity }).hold;
  try { return !(await run("find", [directory, "-xdev", ...unsafe])).stdout.trim(); }
  catch (error) {
    if (process.platform !== "linux") throw error;
    return !(await containerCommand(directory, "inspect", original)).stdout.trim();
  }
}

export async function removeAttemptTree(directory: string, original = directory, guard?: () => Promise<boolean>): Promise<void> {
  try { await fs.promises.rm(directory, { recursive: true, force: true }); }
  catch (error) {
    if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "") || process.platform !== "linux") throw error;
    await containerCommand(directory, "remove", original, guard);
    await fs.promises.rmdir(directory);
  }
}

export async function allocatedAttemptBytes(directory: string): Promise<number> {
  if (process.platform === "win32") return measureTempBytes(directory);
  let output: string | undefined;
  try { output = (await run("du", ["-skx", "--", directory])).stdout; }
  catch {
    if (process.platform === "linux") {
      try { output = (await containerCommand(directory, "measure")).stdout; }
      catch { /* Preserve a lower bound if namespace measurement is unavailable. */ }
    }
  }
  const value = Number(output?.trim().split(/\s+/)[0] ?? NaN);
  if (Number.isFinite(value) && value >= 0) return value * 1024;
  return fs.lstatSync(directory).blocks * 512;
}
