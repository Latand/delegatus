import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { procBackend } from "@/lib/proc";
import { findSeatRound, loadSeatRounds } from "@/lib/prototypeReview/seatRounds";
import { decisionsPOST } from "@/lib/prototypeReview/http";
import { prototypeWorld } from "@/lib/prototypeReview/world";
import { operatorDecisions, seatDecisionNotices } from "@/lib/prototypeReview/read";
import { recordNativeHook } from "./nativeCallProof";
import { nativeAssociation } from "./nativeAssociation";
import { nativeAssociationCurrent, readNativeSessionRecord } from "./nativeCallerSources";
import type { NativeAdmissionEvidence } from "./nativeCaller";

const nativeTest = test.skipIf(process.platform !== "linux");

let root: string; let saved: string | undefined; let evidence: NativeAdmissionEvidence;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-native-association-"));
  saved = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = path.join(root, "state");
  const home = path.join(root, "claude"); const sessionId = ["44444444", "4444", "4444", "8444", "444444444444"].join("-");
  const projects = path.join(home, "projects"); fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(path.join(home, "sessions"));
  const transcript = path.join(projects, `${sessionId}.jsonl`); fs.writeFileSync(transcript, "");
  const processIdentity = procBackend.processIdentity(process.pid)!;
  const domain = `linux:${fs.readFileSync("/etc/machine-id", "utf8").trim()}:${fs.readlinkSync("/proc/self/ns/pid")}`;
  fs.writeFileSync(path.join(home, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, procStart: processIdentity.split(":")[1], pidDomain: domain, kind: "interactive", startedAt: Date.now() }));
  const read = readNativeSessionRecord(home, process.pid); if (read.kind !== "record") throw new Error("fixture record");
  evidence = { home, pid: process.pid, processIdentity, domain, sessionId, transcript, recordRevision: read.revision!, generationProof: recordNativeHook(process.pid, sessionId, transcript, "SessionStart").generation, conversationId: "conversation_native", cwd: root, startedAt: Date.now() };
});
afterEach(() => {
  if (saved === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = saved;
  fs.rmSync(root, { recursive: true, force: true });
});
async function decide(options: number[], extra: Record<string, unknown> = {}, agent = false) {
  const round = loadSeatRounds()[0]!;
  return decisionsPOST(new NextRequest("http://localhost/api/projects/decisions", { method: "POST", headers: { host: "localhost", ...(agent ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) } : {}) },
    body: JSON.stringify({ project: round.project, reviewId: round.id, chosen: [], comment: "", answers: round.questions!.map(q => ({ questionId: q.id, options })), ...extra }) }),
    { ...prototypeWorld, orchestrator: () => null });
}

nativeTest("approval waits on the existing attention surface and is durable and revocable", async () => {
  expect(nativeAssociationCurrent(evidence)).toBe(true);
  expect(nativeAssociation(evidence).status).toBe("waiting");
  expect(nativeAssociation(evidence).status).toBe("waiting");
  expect(loadSeatRounds()).toHaveLength(1); expect(seatDecisionNotices()).toHaveLength(1);
  const shown = loadSeatRounds()[0]!;
  expect(shown.questions![1]!.text).toContain(evidence.cwd); expect(shown.questions![1]!.text).toContain(evidence.transcript);
  expect(shown.questions![1]!.text).toContain(new Date(evidence.startedAt).toISOString());
  expect((await decide([1])).status).toBe(200);
  expect(findSeatRound(shown.id)?.decision?.decidedBy).toEqual({ kind: "operator" });
  const approved = nativeAssociation(evidence); expect(approved.status).toBe("approved");
  expect(nativeAssociation({ ...evidence })).toEqual(approved); expect(seatDecisionNotices()).toHaveLength(0);
  expect(operatorDecisions(shown.project).decisions).toMatchObject([{ nativeAssociationState: "approved", decision: { answers: expect.any(Array) } }]);
  expect((await decide([0])).status).toBe(200); expect(nativeAssociation(evidence).status).toBe("refused");
  expect(operatorDecisions(shown.project).decisions).toHaveLength(0);
});

nativeTest("an agent cannot approve its own native association", async () => {
  nativeAssociation(evidence);
  expect((await decide([1], {}, true)).status).toBe(403);
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("skipping a decision or using a custom answer never approves identity", async () => {
  nativeAssociation(evidence);
  expect((await decide([], { answers: undefined, skip: true })).status).toBe(200);
  expect(nativeAssociation(evidence).status).toBe("refused");
  expect((await decide([], { comment: "approve", answers: [{ questionId: "identity", options: [], other: true }, { questionId: "evidence", options: [1] }] })).status).toBe(200);
  expect(nativeAssociation(evidence).status).toBe("refused");
});

nativeTest("a stale record or ended process cannot be approved and a new revision needs a new decision", async () => {
  nativeAssociation(evidence);
  const record = path.join(evidence.home, "sessions", `${evidence.pid}.json`);
  fs.writeFileSync(record, fs.readFileSync(record));
  expect(nativeAssociationCurrent(evidence)).toBe(false);
  expect((await decide([1])).status).toBe(409);
  expect(nativeAssociation(evidence).status).toBe("waiting");
  const read = readNativeSessionRecord(evidence.home, evidence.pid); if (read.kind !== "record") throw new Error("record");
  expect(nativeAssociation({ ...evidence, recordRevision: read.revision! }).status).toBe("waiting");
  expect(loadSeatRounds()).toHaveLength(2);
  expect(nativeAssociationCurrent({ ...evidence, processIdentity: `${process.pid}:0` })).toBe(false);
});
