import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAntigravityBinary } from "@/lib/agent/cli";
import { antigravityChildEnv } from "@/lib/runtime/antigravityAcpHost";
import { signalDetachedProcessGroup } from "@/lib/processGroup";

import { cliResolvable, type CliPresence } from "./engineConnection";
import { antigravityDefaultHome, isAntigravityAuthFailure, readAntigravityAuthState, recordAntigravityAuthState } from "./antigravity";

/**
 * A real ACP check of Antigravity's Google sign-in (the "Check sign-in" button).
 *
 * `agy` has no login or status subcommand, so the only observation of its auth
 * is the one a launch makes: `initialize`, then `session/new`. This runs those
 * two requests against a throw-away directory, makes no model call, and reads
 * the answer:
 *
 * - a session id came back: signed in, and `_meta.antigravity.tier` names the plan;
 * - an auth error (`-32000`, or the words an auth refusal uses): signed out;
 * - a timeout, a spawn failure or any other error proves nothing, so the
 *   recorded state is left as it was and the caller sees `unknown`.
 *
 * The child runs in the environment a launch uses: `HOME` is the default
 * account's `native-home`, so `session/new` writes its native session state
 * there and never into the operator's own `~/.gemini`. OAuth resolves
 * host-wide under a redirected `HOME` (docs/design/antigravity-engine.md §3.6),
 * so confining the probe changes no answer.
 */

export type AntigravityProbeResult = {
  cli: CliPresence;
  auth: "signed_in" | "signed_out" | "unknown";
  plan: string | null;
  checkedAt: string | null;
  /** True when the probe could not reach an answer (timeout, spawn failure, another error): `auth` is then the last recorded state, unchanged. */
  inconclusive?: boolean;
};

export type AntigravityProbeSpawn = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

const PROBE_TIMEOUT_MS = 20_000;
const MAX_FRAME_BYTES = 1_000_000;

type RpcOutcome = { kind: "result"; value: Record<string, unknown> | null } | { kind: "error"; code: unknown; message: string };

/** The state the last probe or launch recorded, without starting anything. */
export function recordedAntigravityAuth(): Pick<AntigravityProbeResult, "auth" | "plan" | "checkedAt"> {
  const observed = readAntigravityAuthState();
  if (!observed) return { auth: "unknown", plan: null, checkedAt: null };
  return { auth: observed.authenticated ? "signed_in" : "signed_out", plan: observed.tierName, checkedAt: observed.checkedAt };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function runProbe(spawnProcess: AntigravityProbeSpawn, timeoutMs: number): Promise<{ auth: "signed_in" | "signed_out" | "unknown"; tierName: string | null; tierId: string | null }> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-probe-"));
  let child: ChildProcessWithoutNullStreams | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const env = antigravityChildEnv(process.env, antigravityDefaultHome());
    child = spawnProcess(resolveAntigravityBinary(), ["acp", "--disable-telemetry"], { cwd: scratch, env, detached: true });
    const proc = child;
    const pending = new Map<number, (outcome: RpcOutcome) => void>();
    let failed: Error | null = null;
    const failAll = (error: Error) => {
      failed ??= error;
      for (const [id, settle] of pending) { pending.delete(id); settle({ kind: "error", code: null, message: error.message }); }
    };
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) { failAll(new Error("oversized ACP frame")); return; }
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown> | null = null;
        try { message = object(JSON.parse(line)); } catch { /* a stray diagnostic line */ }
        if (!message || typeof message.id !== "number" || typeof message.method === "string") continue;
        const settle = pending.get(message.id);
        if (!settle) continue;
        pending.delete(message.id);
        const error = object(message.error);
        settle(error
          ? { kind: "error", code: error.code, message: typeof error.message === "string" ? error.message : "error" }
          : { kind: "result", value: object(message.result) });
      }
    });
    proc.stderr.on("data", () => { /* diagnostics are not an answer */ });
    proc.stdin.on("error", (error) => failAll(error));
    proc.on("error", (error) => failAll(error));
    proc.on("exit", () => failAll(new Error("agy exited before answering")));
    const deadline = new Promise<RpcOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "error", code: null, message: "timed out" }), timeoutMs);
    });
    let nextId = 1;
    const call = (method: string, params: Record<string, unknown>): Promise<RpcOutcome> => {
      if (failed) return Promise.resolve({ kind: "error", code: null, message: (failed as Error).message });
      const id = nextId++;
      const answered = new Promise<RpcOutcome>((resolve) => pending.set(id, resolve));
      try { proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch (error) { failAll(error instanceof Error ? error : new Error(String(error))); }
      return Promise.race([answered, deadline]);
    };
    const initialized = await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (initialized.kind === "error") return { auth: isAntigravityAuthFailure({ code: initialized.code, message: initialized.message }) ? "signed_out" : "unknown", tierName: null, tierId: null };
    const session = await call("session/new", { cwd: scratch, mcpServers: [] });
    if (session.kind === "error") return { auth: isAntigravityAuthFailure({ code: session.code, message: session.message }) ? "signed_out" : "unknown", tierName: null, tierId: null };
    const tier = object(object(object(session.value?._meta)?.antigravity)?.tier);
    const sessionId = typeof session.value?.sessionId === "string" ? session.value.sessionId : null;
    if (!sessionId) return { auth: "unknown", tierName: null, tierId: null };
    /* Leave no open session behind; its answer does not matter. */
    void call("session/close", { sessionId });
    return {
      auth: "signed_in",
      tierName: typeof tier?.name === "string" ? tier.name : null,
      tierId: typeof tier?.id === "string" ? tier.id : null,
    };
  } catch {
    return { auth: "unknown", tierName: null, tierId: null };
  } finally {
    if (timer) clearTimeout(timer);
    if (child) {
      try { child.stdin.end(); } catch { /* already closed */ }
      signalDetachedProcessGroup(child, "SIGTERM");
      const leader = child;
      setTimeout(() => { if (leader.exitCode === null && leader.signalCode === null) signalDetachedProcessGroup(leader, "SIGKILL"); }, 2_000).unref();
    }
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* temp root cleanup */ }
  }
}

let inFlight: Promise<AntigravityProbeResult> | null = null;

/**
 * Probes once and records what it learned. Concurrent callers share the one
 * child. A missing `agy` is answered without spawning anything.
 */
export function probeAntigravityAuth({ spawnProcess = spawn as AntigravityProbeSpawn, timeoutMs = PROBE_TIMEOUT_MS }: { spawnProcess?: AntigravityProbeSpawn; timeoutMs?: number } = {}): Promise<AntigravityProbeResult> {
  if (inFlight) return inFlight;
  const run = (async (): Promise<AntigravityProbeResult> => {
    if (!cliResolvable(resolveAntigravityBinary())) return { cli: "missing", ...recordedAntigravityAuth() };
    const observed = await runProbe(spawnProcess, timeoutMs);
    if (observed.auth === "unknown") return { cli: "found", ...recordedAntigravityAuth(), inconclusive: true };
    const checkedAt = new Date().toISOString();
    try {
      recordAntigravityAuthState({
        authenticated: observed.auth === "signed_in",
        tierName: observed.auth === "signed_in" ? observed.tierName : null,
        tierId: observed.auth === "signed_in" ? observed.tierId : null,
        checkedAt,
      });
    } catch { /* the answer still reaches the caller */ }
    return { cli: "found", auth: observed.auth, plan: observed.auth === "signed_in" ? observed.tierName : null, checkedAt };
  })().finally(() => { inFlight = null; });
  inFlight = run;
  return run;
}
