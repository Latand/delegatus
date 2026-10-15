import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { nativeAdmissionMessage, resolveNativeCaller, type NativeCallerSources, type NativeCallerReason } from "./nativeCaller";
import { readNativeSessionRecord } from "./nativeCallerSources";

// Synthetic session UUID, kept as segments for the publication scanner.
const SESSION = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
const HOME = "/fixture/claude";
function fixture(overrides: Partial<NativeCallerSources> = {}) {
  const record = { pid: 42, sessionId: SESSION, kind: "interactive", procStart: "100", pidDomain: "linux:fixture:pidns", startedAt: 11_000 };
  const generation = { id: SESSION, path: `${HOME}/projects/project/${SESSION}.jsonl`, archivedAt: null };
  const conversation = { id: "conversation_native", engine: "claude", generations: [generation], supersededBy: null, migration: null };
  const snapshot = { conversations: { conversation_native: conversation }, entries: {} };
  const sources: NativeCallerSources = {
    platform: "linux", ancestry: () => [99, 42, 41], isClaude: (pid) => pid === 42,
    hostStamp: () => null, home: () => HOME, accounts: () => [{ home: HOME, projectsDir: `${HOME}/projects` }],
    realpath: (file) => file, record: () => ({ kind: "record", value: record, revision: "record-1" }), identity: (pid) => `${pid}:100`,
    domain: () => record.pidDomain, bootTime: () => 10_000, processStartedAt: () => 11_000,
    sessionHeldElsewhere: () => false, snapshot: () => snapshot as unknown as ReturnType<NativeCallerSources["snapshot"]>,
    cwd: () => "/fixture/project", generationProof: () => "writer-1",
    association: () => ({ status: "approved", proof: "approved-1" }),
    hostStatus: () => "dead", ...overrides,
  };
  return { sources, record, conversation, generation, snapshot };
}
function refused(sources: NativeCallerSources, reason: NativeCallerReason) {
  expect(resolveNativeCaller(sources)).toEqual({ kind: "refused", reason, retryable: reason === "session-not-scanned" });
}

test("an operator-approved current generation ignores cwd claims in the record", () => {
  const f = fixture();
  Object.assign(f.record, { cwd: "/unrelated/project" });
  expect(resolveNativeCaller(f.sources)).toEqual({ kind: "admitted", conversationId: "conversation_native", proof: "approved-1" });
});

test("a non-Linux server and a server with no Claude parent are refused", () => {
  refused(fixture({ platform: "portable" }).sources, "platform-unverified");
  refused(fixture({ isClaude: () => false }).sources, "no-claude-ancestor");
});

test("only the nearest Claude process can name the caller", () => {
  const f = fixture({ isClaude: () => true, record: (_home, pid) => pid === 42 ? { kind: "missing" } : { kind: "record", value: {} } });
  refused(f.sources, "session-record-missing");
});

test("a Claude host stamped by any installation is refused, including an empty stamp", () => {
  for (const stamp of ["foreign", ""]) refused(fixture({ hostStamp: () => stamp }).sources, "foreign-host");
});

test("a record outside known Claude homes is refused", () => {
  refused(fixture({ home: () => "/foreign" }).sources, "unknown-claude-home");
  refused(fixture({ realpath: () => null }).sources, "unknown-claude-home");
});

test("a record copied under another pid is refused", () => {
  const f = fixture(); f.record.pid = 41;
  refused(f.sources, "session-record-invalid");
});

for (const [name, change] of [
  ["malformed session id", { sessionId: "other" }], ["missing process token", { procStart: null }],
  ["non-numeric token", { procStart: "a" }], ["nonfinite date", { startedAt: Infinity }],
] as const) test(`session record validation: ${name}`, () => {
  const f = fixture(); Object.assign(f.record, change); refused(f.sources, "session-record-invalid");
});

test("background session kinds are refused", () => {
  const f = fixture(); f.record.kind = "bg"; refused(f.sources, "session-kind");
});

test("a record for an earlier process with the same pid is refused", () => {
  refused(fixture({ identity: () => "42:101" }).sources, "process-identity-mismatch");
});

test("a process that exits or changes while the record is read is refused", () => {
  for (const next of [null, "42:101"]) {
    let reads = 0;
    refused(fixture({ identity: () => ++reads === 1 ? "42:100" : next }).sources, "process-identity-mismatch");
  }
});

test("a parent that leaves the ancestry during the read is refused", () => {
  let reads = 0;
  refused(fixture({ ancestry: () => ++reads === 1 ? [99, 42] : [99, 41] }).sources, "process-identity-mismatch");
});

test("the process is rechecked after registry reads", () => {
  let reads = 0;
  refused(fixture({ identity: () => ++reads < 3 ? "42:100" : null }).sources, "process-identity-mismatch");
});

test("a record from another PID domain is refused", () => {
  refused(fixture({ domain: () => "linux:other:pidns" }).sources, "domain-mismatch");
});

test("a record from a previous boot or predating the process is refused at the boundary", () => {
  for (const startedAt of [9_999, 14_999, 15_000]) {
    const f = fixture({ processStartedAt: () => 20_000 }); f.record.startedAt = startedAt;
    if (startedAt < 15_000) refused(f.sources, "record-predates-process");
    else expect(resolveNativeCaller(f.sources).kind).toBe("admitted");
  }
});

test("an unscanned session is retryable and admitted once scanned", () => {
  const f = fixture(); const saved = f.snapshot.conversations;
  f.snapshot.conversations = {} as typeof saved; refused(f.sources, "session-not-scanned");
  f.snapshot.conversations = saved; expect(resolveNativeCaller(f.sources).kind).toBe("admitted");
});

test("a session id owned twice is refused", () => {
  const f = fixture(); Object.assign(f.snapshot.conversations, { other: { ...f.conversation, id: "conversation_other" } });
  refused(f.sources, "generation-ambiguous");
});

for (const state of ["old", "archived", "superseded", "migrating"] as const) test(`a generation that is ${state} is refused`, () => {
  const f = fixture();
  if (state === "old") f.conversation.generations.push({ ...f.generation, id: "next" });
  if (state === "archived") Object.assign(f.generation, { archivedAt: "2026-10-14" });
  if (state === "superseded") Object.assign(f.conversation, { supersededBy: { conversationId: "other" } });
  if (state === "migrating") Object.assign(f.conversation, { migration: { phase: "preparing" } });
  refused(f.sources, "generation-not-current");
});

test("a transcript in another home or with another name is refused", () => {
  for (const file of [`/foreign/${SESSION}.jsonl`, `${HOME}/projects/other.jsonl`]) {
    const f = fixture(); f.generation.path = file; refused(f.sources, "transcript-outside-home");
  }
});

test("a session held by two live processes is refused", () => {
  refused(fixture({ sessionHeldElsewhere: () => true }).sources, "session-held-twice");
});

test("a generation Delegatus is running is refused until its host is proven dead", () => {
  for (const status of ["alive", "unverified", "dead"] as const) {
    const f = fixture({ hostStatus: () => status });
    Object.assign(f.snapshot.entries, { host: { artifactPath: f.generation.path, structuredHost: { process: { pid: 51, startIdentity: null } } } });
    if (status === "dead") expect(resolveNativeCaller(f.sources).kind).toBe("admitted");
    else refused(f.sources, "generation-hosted");
  }
});

test("cwd cannot supply a missing record and source failures close admission", () => {
  refused(fixture({ record: () => ({ kind: "missing" }) }).sources, "session-record-missing");
  refused(fixture({ sessionHeldElsewhere: () => { throw new Error("unreadable home"); } }).sources, "session-record-invalid");
});

test("the real bounded reader refuses symlinks, directories, oversized and malformed records", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-native-record-"));
  const file = path.join(home, "sessions", "42.json");
  try {
    fs.mkdirSync(path.dirname(file));
    expect(readNativeSessionRecord(home, 42)).toEqual({ kind: "missing" });
    const target = path.join(home, "target"); fs.writeFileSync(target, "{}"); fs.symlinkSync(target, file);
    expect(readNativeSessionRecord(home, 42)).toEqual({ kind: "invalid" }); fs.unlinkSync(file);
    fs.mkdirSync(file); expect(readNativeSessionRecord(home, 42)).toEqual({ kind: "invalid" }); fs.rmdirSync(file);
    fs.writeFileSync(file, "{}".padEnd(64 * 1024, " ")); expect(readNativeSessionRecord(home, 42)).toMatchObject({ kind: "record", value: {}, revision: expect.any(String) });
    fs.writeFileSync(file, "{}".padEnd(64 * 1024 + 1, " ")); expect(readNativeSessionRecord(home, 42)).toEqual({ kind: "invalid" });
    fs.writeFileSync(file, "{"); expect(readNativeSessionRecord(home, 42)).toEqual({ kind: "invalid" });
    fs.writeFileSync(file, "{}"); expect(readNativeSessionRecord(home, 42)).toMatchObject({ kind: "record", value: {}, revision: expect.any(String) });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("every refusal gives the reason and continuation route without identity disclosure", () => {
  const reasons: NativeCallerReason[] = ["platform-unverified", "no-claude-ancestor", "capability-unresolved", "capability-conflict", "foreign-host", "unknown-claude-home", "session-record-missing", "session-record-invalid", "session-kind", "process-identity-mismatch", "domain-mismatch", "record-predates-process", "session-held-twice", "session-not-scanned", "generation-ambiguous", "generation-not-current", "transcript-outside-home", "generation-hosted", "session-changed", "session-proof-unavailable", "approval-waiting", "approval-refused", "approval-unavailable"];
  for (const reason of reasons) {
    const text = nativeAdmissionMessage({ reason, retryable: reason === "session-not-scanned" });
    expect(text).toContain(`[${reason}]`); expect(text).toContain("open the conversation in Delegatus");
    expect(text).not.toContain("conversation_native");
  }
});


for (const phase of ["committed", "rolled-back", "failed-recoverable"] as const) test(`terminal migration ${phase} leaves the current native generation admissible`, () => {
  const f = fixture(); Object.assign(f.conversation, { migration: { phase } });
  expect(resolveNativeCaller(f.sources).kind).toBe("admitted");
});

test("a host reservation without a recorded PID stays unverified", () => {
  for (const host of [{ structuredHost: { process: null } }, { host: { agent: null } }]) {
    const f = fixture(); Object.assign(f.snapshot.entries, { reserved: { artifactPath: f.generation.path, ...host } });
    refused(f.sources, "generation-hosted");
  }
});

test("a valid caller-writable record never grants unattended admission", () => {
  refused(fixture({ association: () => ({ status: "waiting", proof: "pending" }) }).sources, "approval-waiting");
  refused(fixture({ association: () => ({ status: "refused", proof: "revoked" }) }).sources, "approval-refused");
  refused(fixture({ generationProof: () => null }).sources, "session-proof-unavailable");
  refused(fixture({ association: () => { throw new Error("store busy"); } }).sources, "approval-unavailable");
});

test("a record rewrite during snapshot refuses the old session before requesting approval", () => {
  const f = fixture(); let approved = false;
  f.sources.snapshot = () => {
    f.record.sessionId = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
    return f.snapshot as unknown as ReturnType<NativeCallerSources["snapshot"]>;
  };
  f.sources.association = () => { approved = true; return { status: "approved", proof: "bad" }; };
  refused(f.sources, "session-changed"); expect(approved).toBe(false);
});

test("a changed record revision or hook generation proof refuses the approved generation", () => {
  for (const seam of ["record", "writer"] as const) {
    const f = fixture(); let reads = 0;
    if (seam === "record") f.sources.record = () => ({ kind: "record", value: f.record, revision: ++reads === 1 ? "record-1" : "record-2" });
    else f.sources.generationProof = () => ++reads === 1 ? "writer-1" : "writer-2";
    refused(f.sources, "session-changed");
  }
});

test("the production record reader detects a session rewrite during snapshot", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-native-switch-"));
  try {
    const f = fixture(); fs.mkdirSync(path.join(home, "sessions"));
    const file = path.join(home, "sessions", "42.json"); fs.writeFileSync(file, JSON.stringify(f.record));
    let reads = 0; let associations = 0;
    f.sources.record = () => { reads++; return readNativeSessionRecord(home, 42); };
    f.sources.snapshot = () => {
      fs.writeFileSync(file, JSON.stringify({ ...f.record, sessionId: ["33333333", "3333", "4333", "8333", "333333333333"].join("-") }));
      return f.snapshot as unknown as ReturnType<NativeCallerSources["snapshot"]>;
    };
    f.sources.association = () => { associations++; return { status: "approved", proof: "bad" }; };
    refused(f.sources, "session-changed"); expect(reads).toBe(2); expect(associations).toBe(0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a new hook generation with an old asynchronously updated record stays refused", () => {
  refused(fixture({ generationProof: () => null }).sources, "session-proof-unavailable");
});
