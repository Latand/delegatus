import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { statePath } from "@/lib/configDir";
import { captureProcessTree, signalProcessGroup } from "@/lib/processGroup";
import { bindHostExitWriter, readHostExit, readHostExitSpool, reclaimHostExit, recordHostExit, recordHostStop } from "./hostExit";

/** Uses the serving interpreter and builtins only, including on installations
 * where the optional namespace launcher/Python is unavailable. */
export const nativeWaitOwnerSource = String.raw`
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const input = JSON.parse(process.argv.at(-1));
const [directory, binary, ...argv] = Array.isArray(input) ? input : input.command;
const stopPath = input.stopPath ?? "codex-socket-startup-cleanup";
const atomic = (file, value, first = false) => {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary = file + "." + crypto.randomUUID();
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (first) { try { fs.linkSync(temporary, file); } catch(e) { if(e.code!=="EEXIST") throw e; } }
    else fs.renameSync(temporary, file);
    if(process.platform !== "win32") {
      const parent = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  } finally { fs.rmSync(temporary, {force:true}); }
};
const child = require("node:child_process").spawn(binary, argv, {stdio:"inherit", detached:true});
let settled = false;
const finish = (code, signal, error) => {
  if(settled) return; settled = true;
  const value = {code, signal, at:new Date().toISOString()};
  if(error) { fs.writeSync(2, "agent engine could not start: " + error.message + "\n"); value.error=error.code; }
  atomic(path.join(directory,"native-exit.json"), value);
  const binding = path.join(directory,"host-exit.json");
  if(fs.existsSync(binding)) {
    const bound = JSON.parse(fs.readFileSync(binding,"utf8"));
    if(!bound.discard) {
      atomic(bound.file, value, true);
      fs.rmSync(bound.file.replace(/\.exit\.json$/, ".writer.json"), {force:true});
    }
  }
  if(fs.existsSync(path.join(directory,"attached"))) fs.rmSync(directory,{recursive:true,force:true});
  process.exitCode = code ?? (signal ? 128 + require("node:os").constants.signals[signal] : 127);
};
child.once("error", error=>finish(null,null,error));
child.once("exit", (code,signal)=>finish(code,signal));
try { atomic(path.join(directory,"native.json"), {pid:child.pid ?? null}); }
catch(error) {
  fs.writeSync(2,"native wait owner readiness failed: " + (error.code ?? error.name) + "\n");
  try { atomic(path.join(directory,"native-stop.json"), {path:stopPath,operationId:crypto.randomUUID(),signal:"SIGKILL",at:new Date().toISOString()}); }
  catch { fs.writeSync(2,"native startup stop intent could not be persisted\n"); }
  try { process.kill(-child.pid,"SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}
`;

/** A stdio engine retains its native PID, process group and pipes. Wait
 * ownership stays outside that group, so signals leave its durable writer alive. */
export function spawnNativeWaitOwner(command: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams & {
  spawnReady: Promise<void>; retainExit(enabled: boolean): void; abortLaunch(): Promise<void>;
} {
  // Engine scratch may be reclaimed before the native process exits. Keep
  // its wait binding with host evidence until the waiter itself removes it.
  const root = statePath("host-exit-waits");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(root, "wait-"));
  const waiter = spawn(process.execPath, ["-e", nativeWaitOwnerSource, "--", JSON.stringify({
    command: [directory, command, ...args], stopPath: "managed-engine-startup-cleanup",
  })], { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const reaped = new Promise<void>(resolve => waiter.once("close", () => resolve()));
  const events = new EventEmitter();
  // Launch failures may happen before the host has installed its listeners.
  events.on("error", () => {});
  let native: ProcessIdentity | null = null;
  let retained = false, closed = false;
  let terminal: ReturnType<typeof readHostExitSpool> = null;
  const evidence = () => readHostExit(native)?.exit ?? terminal?.exit ?? readHostExitSpool(directory)?.exit;
  const cleanup = () => { if (retained && closed) fs.rmSync(directory, { recursive: true, force: true }); };
  for (const event of ["exit", "close"] as const) waiter.on(event, (code, signal) => {
    terminal ??= readHostExitSpool(directory);
    const exit = evidence();
    if (event === "close") closed = true;
    events.emit(event, exit ? exit.code : code, exit ? exit.signal : signal);
    cleanup();
  });
  waiter.on("error", error => events.emit("error", error));
  const spawnReady = (async () => {
    const deadline = performance.now() + 10_000;
    const ready = path.join(directory, "native.json");
    while (!fs.existsSync(ready) && waiter.exitCode === null && waiter.signalCode === null && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!fs.existsSync(ready)) throw new Error("native wait owner did not become ready");
    const pid = JSON.parse(fs.readFileSync(ready, "utf8")).pid;
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("native wait owner returned an invalid PID");
    native = captureProcessIdentity(pid);
  })();
  void spawnReady.catch(() => {});
  const retainExit = (enabled: boolean) => {
    if (enabled && native?.startIdentity) {
      bindHostExitWriter(directory, native, captureProcessIdentity(waiter.pid!));
      const exit = readHostExitSpool(directory)?.exit;
      if (exit) recordHostExit(native, exit.code, exit.signal);
    } else fs.writeFileSync(path.join(directory, "host-exit.json"), JSON.stringify({ discard: true }), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "attached"), "true", { mode: 0o600 });
    retained = true;
    cleanup();
  };
  const abortLaunch = async () => {
    // Capture descendants before the native parent exits and loses them.
    // The independent waiter is outside this tree and must finish its write.
    const tree = native && processIdentityStatus(native) === "alive" ? captureProcessTree(native.pid) : { identities: [], unresolved: [] };
    const withdraw = native && processIdentityStatus(native) === "alive"
      ? recordHostStop(native, "SIGKILL", "managed-engine-startup-cleanup") : undefined;
    for (const descendant of tree.identities.reverse()) {
      if (processIdentityStatus(descendant) === "alive") {
        try { process.kill(descendant.pid, "SIGKILL"); } catch { /* confirmed below */ }
      }
    }
    if (native) {
      if (processIdentityStatus(native) !== "alive") withdraw?.();
      else if (!signalProcessGroup(native.pid, "SIGKILL")) {
        try { process.kill(native.pid, "SIGKILL"); } catch { withdraw?.(); }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + 3_000;
    try {
      await Promise.race([reaped, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("native wait owner startup cleanup did not settle")), 3_000);
      })]);
      while ([...(native ? [native] : []), ...tree.identities].some(identity => processIdentityStatus(identity) !== "dead")) {
        if (performance.now() >= deadline) throw new Error("native startup cleanup left a surviving process");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (tree.unresolved.length) throw new Error("native startup cleanup could not verify every descendant");
    } finally { if (timer) clearTimeout(timer); }
    if (native) reclaimHostExit(native);
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return new Proxy(waiter, { get(target, key) {
    if (key === "spawnReady") return spawnReady;
    if (key === "retainExit") return retainExit;
    if (key === "abortLaunch") return abortLaunch;
    if (key === "pid") return native?.pid ?? target.pid;
    if (key === "spawnargs") return [command, ...args];
    if (key === "exitCode") { const exit = evidence(); return exit ? exit.code : target.exitCode; }
    if (key === "signalCode") { const exit = evidence(); return exit ? exit.signal : target.signalCode; }
    if (key === "kill") return (signal: NodeJS.Signals = "SIGTERM") => {
      if (!native || processIdentityStatus(native) !== "alive") return false;
      try { process.kill(native.pid, signal); return true; } catch { return false; }
    };
    const eventMethod = Reflect.get(events, key, events);
    if (typeof eventMethod === "function") return eventMethod.bind(events);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as ReturnType<typeof spawnNativeWaitOwner>;
}
