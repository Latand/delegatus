import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { systemBootEpoch } from "@/lib/processIdentity";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

interface CallProof { digest: string; generation: string; input: string; expiresAt: number }
interface NativeGeneration { identity: string; sessionId: string; transcript: string; generation: string; ended: boolean; proofs: CallProof[] }
interface CallContext { token?: string; input: string; admitted?: { pid: number; proof: CallProof } }
const calls = new AsyncLocalStorage<CallContext>();
const filename = (pid: number) => statePath("native-callers", `${pid}.json`);
function identity(pid: number): string | null {
  const start = procBackend.processIdentity(pid); const boot = systemBootEpoch();
  return start && boot && !procBackend.processExited(pid) ? `${start}:${boot}` : null;
}

const digest = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function nativeCallInput(tool: string, args: Record<string, unknown>): string {
  const { nativeCallerProof: _proof, ...input } = args; void _proof;
  return digest(JSON.stringify([tool, canonical(input)]));
}
function read(pid: number): NativeGeneration | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename(pid), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 64 * 1024) throw new Error("invalid native proof store");
    const row = JSON.parse(fs.readFileSync(fd, "utf8")) as NativeGeneration;
    if (typeof row.identity !== "string" || typeof row.sessionId !== "string" || typeof row.transcript !== "string"
      || typeof row.generation !== "string" || !/^[a-f0-9]{64}$/.test(row.generation) || typeof row.ended !== "boolean" || !Array.isArray(row.proofs) || row.proofs.length > 32
      || row.proofs.some(proof => !proof || !/^[a-f0-9]{64}$/.test(proof.digest) || !/^[a-f0-9]{64}$/.test(proof.input)
        || proof.generation !== row.generation || typeof proof.expiresAt !== "number" || !Number.isFinite(proof.expiresAt))) throw new Error("invalid native proof store");
    return row;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function mutate<T>(pid: number, change: (row: NativeGeneration | null) => { row: NativeGeneration | null; value: T }): T {
  const file = filename(pid);
  return withFileTransactionSync(file, "native caller proof is busy", () => {
    const result = change(read(pid));
    if (!result.row) return result.value;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const staging = `${file}.${crypto.randomBytes(8).toString("hex")}.write`;
    try { fs.writeFileSync(staging, JSON.stringify(result.row), { mode: 0o600, flag: "wx", flush: true }); fs.renameSync(staging, file); }
    finally { fs.rmSync(staging, { force: true }); }
    return result.value;
  });
}
/** Only the hook entry calls this with a kernel-derived ancestor. No protocol
 * argument can supply the PID. Compaction retains the current generation when
 * its process, session and transcript are unchanged. */
export function recordNativeHook(pid: number, sessionId: string, transcript: string, event: "SessionStart" | "SessionEnd" | "PreToolUse", tool = "", args: Record<string, unknown> = {}, source?: string): { generation: string; token?: string } {
  const pinned = identity(pid);
  if (!pinned || !procBackend.pidAlive(pid) || procBackend.processExited(pid) || !procBackend.processIdentity(pid) || !systemBootEpoch()) throw new Error("native parent unavailable");
  return mutate(pid, held => {
    if (event === "SessionEnd" && (!held || held.identity !== pinned || held.sessionId !== sessionId || held.transcript !== transcript || held.ended)) {
      return { row: null, value: { generation: held?.generation ?? "" } };
    }
    const fresh = !held || held.identity !== pinned || held.ended || held.sessionId !== sessionId || held.transcript !== transcript || (event === "SessionStart" && source !== "compact");
    const row: NativeGeneration = fresh ? { identity: pinned, sessionId, transcript, generation: crypto.randomBytes(32).toString("hex"), ended: false, proofs: [] } : held!;
    if (event === "SessionEnd") { row.ended = true; row.proofs = []; }
    let token: string | undefined;
    if (event === "PreToolUse") {
      token = crypto.randomBytes(32).toString("base64url");
      row.proofs = row.proofs.filter(proof => proof.expiresAt > Date.now()).slice(-31);
      row.proofs.push({ digest: digest(token), generation: row.generation, input: nativeCallInput(tool, args), expiresAt: Date.now() + 5 * 60_000 });
    }
    if (identity(pid) !== pinned || procBackend.processExited(pid)) throw new Error("native parent changed");
    return { row, value: { generation: row.generation, ...(token ? { token } : {}) } };
  });
}
/** One RPC's proof is consumed once; all of its admission/use checks share the
 * same async context. Another RPC, including replay, needs a fresh hook proof. */
export function runWithNativeCallProof<T>(token: string | undefined, tool: string, args: Record<string, unknown>, operation: () => T): T {
  return calls.run({ token, input: token ? nativeCallInput(tool, args) : "" }, operation);
}
export function nativeGenerationCurrent(pid: number, sessionId: string, transcript: string, generation: string): boolean {
  const row = read(pid);
  return Boolean(row && !row.ended && row.identity === identity(pid) && row.sessionId === sessionId && row.transcript === transcript && row.generation === generation);
}
export function nativeTranscriptCallProof(pid: number, transcript: string): string | null {
  const call = calls.getStore();
  if (!call?.token || !/^[A-Za-z0-9_-]{43}$/.test(call.token)) return null;
  if (!call.admitted) {
    const proof = mutate<CallProof | null>(pid, row => {
      if (!row || row.ended || row.identity !== identity(pid)) return { row: null, value: null };
      const at = row.proofs.findIndex(proof => proof.digest === digest(call.token!) && proof.input === call.input && proof.expiresAt > Date.now() && proof.generation === row.generation);
      if (at < 0) return { row: null, value: null };
      const proof = row.proofs.splice(at, 1)[0]!;
      return { row, value: proof as CallProof | null };
    });
    if (!proof) return null;
    call.admitted = { pid, proof };
  }
  const admitted = call.admitted;
  const sessionId = path.basename(transcript, ".jsonl");
  return admitted.pid === pid && nativeGenerationCurrent(pid, sessionId, transcript, admitted.proof.generation) ? admitted.proof.generation : null;
}

/** A sibling's writable PID record cannot by itself hold another session. */
export function nativeSessionObserved(pid: number, sessionId: string): boolean {
  const row = read(pid);
  return Boolean(row && !row.ended && row.identity === identity(pid) && row.sessionId === sessionId);
}
