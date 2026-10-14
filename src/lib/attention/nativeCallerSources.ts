import fs from "node:fs";
import path from "node:path";

import { listClaudeAccounts } from "@/lib/accounts/claude";
import type { AgentRegistry } from "@/lib/agent/registry";
type RegistrySnapshot = ReturnType<AgentRegistry["readOnlySnapshot"]>;
import { procBackend } from "@/lib/proc";
import { processIdentityStatus } from "@/lib/processIdentity";
import { argvEngine, isHelperArgv, readStructuredHostStamp } from "@/lib/scanner/process";
import { processAncestry } from "./callerAuthority";
import { nativeSessionRecord, type NativeCallerSources, type NativeRecordRead } from "./nativeCaller";

const MAX_RECORD_BYTES = 64 * 1024;

/** Open the file without following a link, then validate and bound that same descriptor. */
export function readNativeSessionRecord(home: string, pid: number): NativeRecordRead {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(path.join(home, "sessions", `${pid}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > MAX_RECORD_BYTES) return { kind: "invalid" };
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > MAX_RECORD_BYTES) return { kind: "invalid" };
    return { kind: "record", value: JSON.parse(buffer.subarray(0, length).toString("utf8")) };
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function realpath(file: string): string | null {
  try { return fs.realpathSync(file); } catch { return null; }
}

export function nativeCallerSources(snapshot: () => Pick<RegistrySnapshot, "conversations" | "entries">): NativeCallerSources {
  // Per-resolution snapshots; a later tool call rereads both accounts and records.
  const accounts = listClaudeAccounts();
  const bootTime = (): number | null => {
    const match = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    return match ? Number(match[1]) * 1000 : null;
  };
  return {
    platform: procBackend.name,
    ancestry: () => processAncestry(process.pid, (pid) => procBackend.readPpid(pid)),
    isClaude: (pid) => {
      const argv = procBackend.readArgv(pid);
      return argvEngine(argv) === "claude" && !isHelperArgv(argv);
    },
    hostStamp: readStructuredHostStamp,
    home: (pid) => procBackend.readEnvVar(pid, "CLAUDE_CONFIG_DIR")
      || (procBackend.readEnvVar(pid, "HOME") ? path.join(procBackend.readEnvVar(pid, "HOME")!, ".claude") : null),
    accounts: () => accounts,
    realpath,
    record: readNativeSessionRecord,
    identity: (pid) => procBackend.pidAlive(pid) && !procBackend.processExited(pid) ? procBackend.processIdentity(pid) : null,
    domain: (pid) => `linux:${fs.readFileSync("/etc/machine-id", "utf8").trim()}:${fs.readlinkSync(`/proc/${pid}/ns/pid`)}`,
    bootTime,
    processStartedAt: (pid) => {
      const token = procBackend.processIdentity(pid)?.split(":")[1];
      const boot = bootTime();
      // Linux /proc uses USER_HZ=100, as does the process backend.
      return token && boot !== null ? boot + Number(token) * 10 : null;
    },
    sessionHeldElsewhere: (sessionId, callerPid) => {
      for (const account of accounts) {
        let files: string[];
        try { files = fs.readdirSync(path.join(account.home, "sessions")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for (const file of files) {
          if (!/^[1-9]\d*\.json$/.test(file)) continue;
          const pid = Number(file.slice(0, -5));
          if (!Number.isSafeInteger(pid) || pid === callerPid) continue;
          const read = readNativeSessionRecord(account.home, pid);
          if (read.kind !== "record") continue;
          const record = nativeSessionRecord(read.value, pid);
          if (record?.sessionId === sessionId && procBackend.pidAlive(pid) && !procBackend.processExited(pid)
            && procBackend.processIdentity(pid) === `${pid}:${record.procStart}`) return true;
        }
      }
      return false;
    },
    snapshot,
    hostStatus: processIdentityStatus,
  };
}
