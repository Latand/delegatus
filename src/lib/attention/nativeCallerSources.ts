import crypto from "node:crypto";
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

import { nativeGenerationCurrent, nativeSessionObserved, nativeTranscriptCallProof } from "./nativeCallProof";
import { nativeAssociation } from "./nativeAssociation";

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
    const after = fs.fstatSync(descriptor);
    if (stat.ino !== after.ino || stat.size !== after.size || stat.ctimeMs !== after.ctimeMs || stat.mtimeMs !== after.mtimeMs) return { kind: "invalid" };
    const bytes = buffer.subarray(0, length);
    return { kind: "record", value: JSON.parse(bytes.toString("utf8")),
      revision: `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}:${crypto.createHash("sha256").update(bytes).digest("hex")}` };
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function realpath(file: string): string | null {
  try { return fs.realpathSync(file); } catch { return null; }
}

export function nativeCallerSources(snapshot: () => Pick<RegistrySnapshot, "conversations" | "entries">, peerPid = process.pid): NativeCallerSources {
  // Per-resolution snapshots; a later tool call rereads both accounts and records.
  const accounts = listClaudeAccounts();
  const bootTime = (): number | null => {
    const match = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    return match ? Number(match[1]) * 1000 : null;
  };
  return {
    platform: procBackend.name,
    ancestry: () => processAncestry(peerPid, (pid) => procBackend.readPpid(pid)),
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
            && procBackend.processIdentity(pid) === `${pid}:${record.procStart}` && nativeSessionObserved(pid, sessionId)) return true;
        }
      }
      return false;
    },
    cwd: (pid) => procBackend.readCwd(pid),
    association: nativeAssociation,
    generationProof: nativeGenerationProof,
    snapshot,
    hostStatus: processIdentityStatus,
  };
}

/** Each call needs fresh proof from Claude's synchronous PreToolUse hook. */
export function nativeGenerationProof(pid: number, transcript: string): string | null {
  return nativeTranscriptCallProof(pid, transcript);
}

/** Approval is refused if the process or the shown generation ended while the
 * operator was reading. The admission resolver repeats the registry guards. */
export function nativeAssociationCurrent(evidence: import("./nativeCaller").NativeAdmissionEvidence): boolean {
  if (!procBackend.pidAlive(evidence.pid) || procBackend.processExited(evidence.pid)
    || procBackend.processIdentity(evidence.pid) !== evidence.processIdentity) return false;
  const read = readNativeSessionRecord(evidence.home, evidence.pid);
  const record = read.kind === "record" ? nativeSessionRecord(read.value, evidence.pid) : null;
  if (read.kind !== "record" || !record || JSON.stringify(record) !== JSON.stringify(evidence.recordIdentity)
    || `${record.pid}:${record.procStart}` !== evidence.processIdentity || record.sessionId !== evidence.sessionId
    || record.pidDomain !== evidence.domain) return false;
  return nativeGenerationCurrent(evidence.pid, evidence.sessionId, evidence.transcript, evidence.generationProof);
}
