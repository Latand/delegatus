import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { nativeGenerationCurrent, nativeSessionObserved, nativeTranscriptCallProof, recordNativeHook, runWithNativeCallProof } from "./nativeCallProof";
const nativeTest = test.skipIf(process.platform !== "linux");

let root: string; let saved: string | undefined;
const A = ["55555555", "5555", "4555", "8555", "555555555555"].join("-");
const B = ["66666666", "6666", "4666", "8666", "666666666666"].join("-");
const transcript = (id: string) => `/fixture/${id}.jsonl`;
const args = { clientRequestId: "original-key", cwd: "/fixture/project", prompt: "hello", title: "Proof fixture" };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-native-proof-")); saved = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = root; });
afterEach(() => { if (saved === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = saved; fs.rmSync(root, { recursive: true, force: true }); });

nativeTest("a fresh hook proof authenticates one exact call and cannot be replayed", () => {
  const proof = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
  expect(runWithNativeCallProof(proof.token, "spawn_agent", args, () => {
    const first = nativeTranscriptCallProof(process.pid, transcript(A));
    expect(nativeTranscriptCallProof(process.pid, transcript(A))).toBe(first); return first;
  })).toBe(proof.generation);
  expect(runWithNativeCallProof(proof.token, "spawn_agent", args, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBeNull();
});
nativeTest("a proof cannot be moved to another tool, payload or parent", () => {
  const proof = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
  expect(runWithNativeCallProof(proof.token, "send_message", args, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBeNull();
  expect(runWithNativeCallProof(proof.token, "spawn_agent", { ...args, prompt: "other" }, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBeNull();
  expect(runWithNativeCallProof(proof.token, "spawn_agent", args, () => nativeTranscriptCallProof(99999998, transcript(A)))).toBeNull();
  expect(runWithNativeCallProof(proof.token, "spawn_agent", args, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBe(proof.generation);
});
nativeTest("session switch invalidates admitted and unconsumed proof, including a return to the same transcript", () => {
  const first = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
  runWithNativeCallProof(first.token, "spawn_agent", args, () => {
    expect(nativeTranscriptCallProof(process.pid, transcript(A))).toBe(first.generation);
    recordNativeHook(process.pid, B, transcript(B), "SessionStart");
    expect(nativeTranscriptCallProof(process.pid, transcript(A))).toBeNull();
  });
  recordNativeHook(process.pid, A, transcript(A), "SessionStart");
  expect(nativeGenerationCurrent(process.pid, A, transcript(A), first.generation)).toBe(false);
});
nativeTest("session end closes the generation and the next start needs a fresh association", () => {
  const first = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
  recordNativeHook(process.pid, A, transcript(A), "SessionEnd");
  expect(nativeGenerationCurrent(process.pid, A, transcript(A), first.generation)).toBe(false);
  expect(runWithNativeCallProof(first.token, "spawn_agent", args, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBeNull();
  const next = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
  expect(next.generation).not.toBe(first.generation);
});

nativeTest("proof expiry refuses exactly at the five-minute boundary", () => {
  const now = Date.now();
  try {
    setSystemTime(now);
    const before = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
    const boundary = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
    setSystemTime(now + 5 * 60_000 - 1);
    expect(runWithNativeCallProof(before.token, "spawn_agent", args, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBe(before.generation);
    setSystemTime(now + 5 * 60_000);
    expect(runWithNativeCallProof(boundary.token, "spawn_agent", args, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBeNull();
  } finally { setSystemTime(); }
});

nativeTest("a stale end event cannot close another session's generation", () => {
  recordNativeHook(process.pid, A, transcript(A), "SessionStart");
  const current = recordNativeHook(process.pid, B, transcript(B), "SessionStart");
  recordNativeHook(process.pid, A, transcript(A), "SessionEnd");
  expect(nativeGenerationCurrent(process.pid, B, transcript(B), current.generation)).toBe(true);
});

nativeTest("only 32 pending proofs remain and old proof cannot revive", () => {
  const old = recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
  for (let i = 0; i < 32; i++) recordNativeHook(process.pid, A, transcript(A), "PreToolUse", "spawn_agent", args);
  expect(runWithNativeCallProof(old.token, "spawn_agent", args, () => nativeTranscriptCallProof(process.pid, transcript(A)))).toBeNull();
});

nativeTest("a writable sibling session claim cannot replace the hook-observed session", () => {
  recordNativeHook(process.pid, B, transcript(B), "SessionStart");
  expect(nativeSessionObserved(process.pid, B)).toBe(true);
  expect(nativeSessionObserved(process.pid, A)).toBe(false);
});
