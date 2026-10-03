/* Recovery processes are taken over only by their recorded identity and the
   install socket in their own environment. An occupied port alone owns no PID. */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { installedRelease, readStartIdentity, runtimeHostStartIdentity } from "./self-update-supervisor.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function ownsListeningPort(pid, port) {
  try {
    if (process.platform === "darwin") {
      const result = spawnSync("lsof", ["-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], { encoding: "utf8", timeout: 2_000 });
      return result.status === 0 && result.stdout.split("\n").includes(`p${pid}`)
        && result.stdout.split("\n").some(line => line.startsWith("n") && line.endsWith(`:${port}`));
    }
    if (process.platform !== "linux") return false;
    const inodes = new Set();
    for (const table of ["tcp", "tcp6"]) {
      for (const row of readFileSync(`/proc/${pid}/net/${table}`, "utf8").trim().split("\n").slice(1)) {
        const fields = row.trim().split(/\s+/);
        if (fields[3] === "0A" && parseInt(fields[1].split(":")[1], 16) === port) inodes.add(`socket:[${fields[9]}]`);
      }
    }
    return readdirSync(`/proc/${pid}/fd`).some(fd => {
      try { return inodes.has(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { return false; }
    });
  } catch { return false; }
}
function alive(pid, identity) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X" && fields[19] === identity;
  } catch {
    if (process.platform !== "linux" && readStartIdentity(pid) === identity) { try { process.kill(pid, 0); return true; } catch { return false; } }
    return false;
  }
}
function matchingProcess(candidate, socket, port = null, installRoot = null, releasePointer = null) {
  if (!Number.isSafeInteger(candidate?.pid) || candidate.pid <= 1 || candidate.pid === process.pid
    || typeof candidate.startIdentity !== "string" || !alive(candidate.pid, candidate.startIdentity)) return false;
  try {
    const env = process.platform === "darwin"
      ? spawnSync("ps", ["eww", "-p", String(candidate.pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 }).stdout.trim().split(/\s+/)
      : readFileSync(`/proc/${candidate.pid}/environ`, "utf8").split("\0");
    // Next may set PORT after exec, so the initial environment cannot prove
    // listener custody. Match a listening socket to this exact process instead.
    if (port !== null && !ownsListeningPort(candidate.pid, port)) return false;
    if (env.includes(`LLV_RUNTIME_HOST_SOCKET=${socket}`)) return true;
    // A manually started first-party Viewer has no host socket marker. Its
    // declared owner, recorded root and kernel cwd provide the missing proof.
    if (port === null || !installRoot || candidate.installRoot !== installRoot || !env.includes("LLV_STATE_OWNER=viewer")) return false;
    const cwd = process.platform === "darwin"
      ? spawnSync("lsof", ["-a", "-p", String(candidate.pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 2_000 }).stdout.split("\n").find(line => line.startsWith("n"))?.slice(1)
      : readlinkSync(`/proc/${candidate.pid}/cwd`);
    const release = releasePointer ? installedRelease(releasePointer, installRoot).dir : installRoot;
    return !!cwd && [installRoot, release].some(root => realpathSync(root) === cwd);
  } catch { return false; }
}
async function stopRecorded(candidate, socket, port = null, installRoot = null, releasePointer = null) {
  if (!matchingProcess(candidate, socket, port, installRoot, releasePointer)) return false;
  const signal = value => {
    if (!matchingProcess(candidate, socket, port, installRoot, releasePointer)) return;
    try { process.kill(candidate.pid, value); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (alive(candidate.pid, candidate.startIdentity) && Date.now() < deadline) await wait(50);
  if (alive(candidate.pid, candidate.startIdentity)) signal("SIGKILL");
  return true;
}
function json(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
export function assertLauncherAvailable(paths) {
  const other = json(paths.record)?.launcher;
  if (other && other.pid !== process.pid && alive(other.pid, other.startIdentity)) {
    throw new Error("A live launcher already supervises this installation.");
  }
}
export function portFree(port, hostname = "127.0.0.1") {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, hostname, () => server.close(() => resolve(true)));
  });
}
export async function ensureWebPortFree(paths, port, socket, hostname = "127.0.0.1", installRoot = null) {
  if (await portFree(port, hostname)) return true;
  const candidate = json(paths.adopt);
  if (candidate?.port !== port || candidate?.socket !== socket || !await stopRecorded(candidate, socket, port, installRoot, paths.releasePointer)) return false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await portFree(port, hostname)) { rmSync(paths.adopt, { force: true }); return true; }
    await wait(50);
  }
  return false;
}
export async function takeOverOrphanHost(paths, config, ports = { launcherIdentity: readStartIdentity, hostIdentity: runtimeHostStartIdentity, stop: stopRecorded }) {
  const other = json(paths.record)?.launcher;
  // A verified live supervisor retains custody of its host.
  if (other && alive(other.pid, other.startIdentity)) return false;
  const fence = json(config.fencePath);
  if (!fence || typeof fence.startIdentity !== "string") return false;
  const identity = ports.launcherIdentity(fence.pid);
  if (identity === null || fence.startIdentity !== ports.hostIdentity(fence.pid)) return false;
  return ports.stop({ pid: fence.pid, startIdentity: identity }, config.socketPath);
}
