import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import type { TempSweepRoot } from "@/lib/tempSweep";

export function tempViewAvailable(root: TempSweepRoot): boolean {
  if (!root.via) return true;
  if (!root.anchor) return false;
  if (root.via === "/proc/1/root" && root.anchor.pid === 1)
    return stageHostNamespace() === root.anchor.namespace;
  try { return fs.readlinkSync(path.join(path.dirname(root.via), "ns/mnt")) === root.anchor.namespace; }
  catch { return false; }
}

/** Docker's CLI shims target PID 1. An unrelated agent namespace cannot
    establish a required stage write volume. The image's setuid nsenter can
    read that namespace when direct proc access is denied, as the shims do. */
export function stageHostNamespace(): string | null {
  try { return fs.readlinkSync("/proc/1/ns/mnt"); }
  catch { /* PID 1 can belong to another user. */ }
  try {
    const result = enterStageHost("/bin/readlink", ["/proc/self/ns/mnt"]);
    const namespace = result.stdout?.trim();
    return result.status === 0 && /^mnt:\[\d+\]$/.test(namespace) ? namespace : null;
  } catch { return null; }
}

export function hostCommandArgs(pid: number, command: string, args: string[]): string[] {
  const gid = process.getgid?.() ?? 0;
  const groups = [...new Set([gid, ...(process.getgroups?.() ?? [])])].sort((a, b) => a - b);
  return ["-t", String(pid), "-m", "-p", "--", "/usr/bin/setpriv",
    `--reuid=${process.getuid?.() ?? 0}`, `--regid=${gid}`,
    `--groups=${groups.join(",")}`, "--", command, ...args];
}

export function enterStageHost(command: string, args: string[]): childProcess.SpawnSyncReturns<string> {
  return childProcess.spawnSync("nsenter", hostCommandArgs(1, command, args), { encoding: "utf8", timeout: 2_000 });
}

/** PID 1 belongs to another user on many hosts. A reader running as our uid
    gives measurements and sweeps a readable root in the same namespace.
    Closing its input reaps it; its own timer also bounds a lost caller. */
async function hostReaderView(namespace: string) {
  try { fs.statSync("/proc/1/root"); return null; } catch { /* Use our own reader. */ }
  const child = childProcess.spawn("nsenter", hostCommandArgs(1, path.join(os.homedir(), ".bun/bin/bun"), ["-e", `
    console.log(JSON.stringify({ pid: process.pid, namespace: require("node:fs").readlinkSync("/proc/self/ns/mnt") }));
    let timer;
    const renew = () => { clearTimeout(timer); timer = setTimeout(() => process.exit(0), 60_000); };
    process.stdin.on("data", renew);
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    renew();
  `]), { stdio: ["pipe", "pipe", "ignore"] });
  const heartbeat = setInterval(() => child.stdin.write("."), 20_000);
  heartbeat.unref();
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
  child.once("close", () => clearInterval(heartbeat)); child.once("error", () => clearInterval(heartbeat));
  child.stdin.on("error", () => { /* A failed reader has already closed its input. */ });
  const release = async () => { clearInterval(heartbeat); child.stdin.end(); await closed; };
  const line = await new Promise<string | null>(resolve => {
    let text = "";
    const finish = (value: string | null) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.stdin.end(); child.kill(); finish(null); }, 2_000);
    child.once("error", () => finish(null)); child.once("close", () => finish(null));
    child.stdout.on("data", chunk => {
      text += String(chunk);
      if (text.length > 1_024) finish(null);
      else if (text.includes("\n")) finish(text.split("\n")[0]);
    });
  });
  try {
    const observed = JSON.parse(line ?? "null") as { pid?: number; namespace?: string } | null;
    if (observed?.namespace === namespace && Number.isInteger(observed.pid) && observed.pid! > 0) {
      const view = { via: `/proc/${observed.pid}/root`, anchor: { pid: observed.pid!, namespace } };
      if (tempViewAvailable({ ...view, path: "/" }) && stageHostNamespace() === namespace) {
        fs.statSync(view.via);
        return { ...view, release };
      }
    }
  } catch { /* No validated view means no host allocations can be credited. */ }
  await release();
  return null;
}

export function includeIdleHostViews(roots: readonly TempSweepRoot[], env: Readonly<Record<string, string | undefined>> = process.env): TempSweepRoot[] {
  const namespace = env.LLV_DOCKER_NSENTER_SHIMS === "1" ? stageHostNamespace() : null;
  const views = [...roots];
  if (namespace) for (const root of roots.filter(root => !root.via)) {
    if (!views.some(view => view.path === root.path && view.via === "/proc/1/root" && view.anchor?.namespace === namespace))
      views.push({ ...root, via: "/proc/1/root", anchor: { pid: 1, namespace } });
  }
  return views;
}

/** A borrowed root is released after its measurement or sweep finishes. */
export async function openHostTempRoots(roots: readonly TempSweepRoot[], env: Readonly<Record<string, string | undefined>> = process.env) {
  const views = includeIdleHostViews(roots, env);
  const namespace = views.find(root => root.via === "/proc/1/root")?.anchor?.namespace;
  const reader = namespace ? await hostReaderView(namespace) : null;
  return {
    roots: views.map(root => reader && root.via === "/proc/1/root" ? { ...root, via: reader.via, anchor: reader.anchor } : root),
    close: async () => { await reader?.release(); },
  };
}
