import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as claimPOST } from "@/app/api/team/claim/route";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { closeAgentRegistryForTests } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";
import { clearSeatRoundsForTests, findSeatRound, insertSeatRound, loadSeatRounds, mutateSeatRound } from "@/lib/prototypeReview/seatRounds";
import { decisionsPOST } from "@/lib/prototypeReview/http";
import { prototypeWorld } from "@/lib/prototypeReview/world";
import { operatorDecisions, seatDecisionNotices } from "@/lib/prototypeReview/read";
import { decidePrototype } from "@/lib/prototypeReview/decision";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { destinationRelay } from "@/lib/externalRelay/ownerDestination.fixture";
import { updateRelayStore } from "@/lib/externalRelay/store";
import { recordNativeHook } from "./nativeCallProof";
import { nativeAssociation } from "./nativeAssociation";
import { nativeAssociationDecisionApproves } from "./nativeAssociationForm";
import { nativeAssociationCurrent, readNativeSessionRecord } from "./nativeCallerSources";
import { nativeSessionRecord, type NativeAdmissionEvidence } from "./nativeCaller";

const nativeTest = test.skipIf(process.platform !== "linux");

let root: string; let saved: string | undefined; let evidence: NativeAdmissionEvidence;
beforeEach(() => {
  closeAgentRegistryForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-native-association-"));
  saved = process.env.LLV_STATE_DIR; process.env.LLV_STATE_DIR = path.join(root, "state");
  resetTeamStoreForTests();
  const home = path.join(root, "claude"); const sessionId = ["44444444", "4444", "4444", "8444", "444444444444"].join("-");
  const projects = path.join(home, "projects"); fs.mkdirSync(projects, { recursive: true }); fs.mkdirSync(path.join(home, "sessions"));
  const transcript = path.join(projects, `${sessionId}.jsonl`); fs.writeFileSync(transcript, "");
  const processIdentity = procBackend.processIdentity(process.pid)!;
  const domain = `linux:${fs.readFileSync("/etc/machine-id", "utf8").trim()}:${fs.readlinkSync("/proc/self/ns/pid")}`;
  fs.writeFileSync(path.join(home, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, procStart: processIdentity.split(":")[1], pidDomain: domain, kind: "interactive", startedAt: Date.now() }));
  const read = readNativeSessionRecord(home, process.pid); if (read.kind !== "record") throw new Error("fixture record");
  evidence = { home, pid: process.pid, processIdentity, domain, sessionId, transcript, recordIdentity: nativeSessionRecord(read.value, process.pid)!, generationProof: recordNativeHook(process.pid, sessionId, transcript, "SessionStart").generation, conversationId: "conversation_native", cwd: root, startedAt: Date.now() };
});
afterEach(() => {
  closeAgentRegistryForTests();
  resetTeamStoreForTests();
  if (saved === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = saved;
  fs.rmSync(root, { recursive: true, force: true });
});
async function decide(options: number[], extra: Record<string, unknown> = {}, agent = false, cookie?: string, headers: Record<string, string> = {}) {
  const round = findSeatRound(`pr_${nativeAssociation(evidence).proof.slice(0, 32)}`)!;
  return decisionsPOST(new NextRequest("http://localhost/api/projects/decisions", { method: "POST", headers: { host: "localhost", ...headers, ...(cookie ? { cookie: `${MEMBER_COOKIE}=${cookie}` } : {}), ...(agent ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: "a".repeat(43) } : {}) },
    body: JSON.stringify({ project: round.project, reviewId: round.id, chosen: [], comment: "", answers: round.questions!.map(q => ({ questionId: q.id, options })), ...extra }) }),
    { ...prototypeWorld, orchestrator: () => null });
}
const desktop = { surface: "desktop" as const, browser: "chrome" as const };
function owner() {
  const signedIn = claimInstall(teamStore(), "Owner", desktop);
  updateRelayStore(store => ({ ...store, relays: [destinationRelay()] }));
  const member = { ...signedIn.member, telegram: { userId: "41", username: null, firstName: null, linkedAt: new Date().toISOString() } };
  teamStore().updateMember(member);
  const session = mintSession(teamStore(), member.id, "telegram", desktop);
  return { member, cookie: session.value, session: session.session };
}
async function decideAsOwner(options: number[], extra: Record<string, unknown> = {}, cookie = owner().cookie) {
  return decide(options, extra, false, cookie);
}

nativeTest("approval waits on the existing attention surface and is durable and revocable", async () => {
  const signedIn = owner();
  expect(nativeAssociationCurrent(evidence)).toBe(true);
  expect(nativeAssociation(evidence).status).toBe("waiting");
  expect(nativeAssociation(evidence).status).toBe("waiting");
  expect(loadSeatRounds()).toHaveLength(1); expect(seatDecisionNotices()).toHaveLength(1);
  const shown = loadSeatRounds()[0]!;
  expect(shown.questions![1]!.text).toContain(evidence.cwd); expect(shown.questions![1]!.text).toContain(evidence.transcript);
  expect(shown.questions![1]!.text).toContain(new Date(evidence.startedAt).toISOString());
  expect((await decideAsOwner([1], {}, signedIn.cookie)).status).toBe(200);
  expect(findSeatRound(shown.id)?.decision?.decidedBy).toEqual({ kind: "member", memberId: signedIn.member.id });
  const approved = nativeAssociation(evidence); expect(approved.status).toBe("approved");
  expect(nativeAssociation({ ...evidence })).toEqual(approved); expect(seatDecisionNotices()).toHaveLength(0);
  expect(operatorDecisions(shown.project).decisions).toMatchObject([{ nativeAssociationState: "approved", decision: { answers: expect.any(Array) } }]);
  expect((await decideAsOwner([0], {}, signedIn.cookie)).status).toBe(200); expect(nativeAssociation(evidence).status).toBe("refused");
  expect(operatorDecisions(shown.project).decisions).toHaveLength(0);
});

nativeTest("an agent cannot approve its own native association", async () => {
  nativeAssociation(evidence);
  expect((await decide([1], {}, true)).status).toBe(403);
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("a header-free native caller cannot grant itself operator approval on a solo installation", async () => {
  nativeAssociation(evidence);
  expect((await decide([1], {}, false)).status).toBe(403);
  expect(nativeAssociation(evidence).status).toBe("waiting");
  expect(loadSeatRounds()[0]!.decision).toBeUndefined();
});

nativeTest("forged browser headers and an access key do not prove an owner session", async () => {
  nativeAssociation(evidence);
  const response = await decide([1], {}, false, undefined, { origin: "http://localhost", "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0", authorization: ["Bearer", "fixture-access-key"].join(" ") });
  expect(response.status).toBe(403);
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("caller-supplied authorization fields cannot bypass the decision boundary", async () => {
  nativeAssociation(evidence);
  expect((await decide([1], { nativeAssociationApproval: "paired-owner", decidedBy: { kind: "operator" } })).status).toBe(403);
  const round = loadSeatRounds()[0]!;
  const input = { reviewId: round.id, chosen: [], comment: "", answers: round.questions!.map(q => ({ questionId: q.id, options: [1] })) };
  const request = new NextRequest("http://localhost/api/projects/decisions");
  expect(() => decidePrototype(request, null, input)).toThrow("paired Telegram owner");
  expect(() => decidePrototype(request, null, { reviewId: round.id, retry: true })).toThrow("paired Telegram owner");
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("a member session and a revoked owner session cannot approve identity", async () => {
  nativeAssociation(evidence);
  const signedIn = owner();
  const member = redeemJoin(teamStore(), createInvite(teamStore(), signedIn.member, "Member").code, "Member", desktop);
  expect((await decide([1], {}, false, member.cookie)).status).toBe(403);
  expect((await decide([1], {}, true, signedIn.cookie)).status).toBe(403);
  teamStore().revokeSession(signedIn.session.id, new Date().toISOString());
  expect((await decide([1], {}, false, signedIn.cookie)).status).toBe(401);
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("an expired owner session cannot approve identity", async () => {
  nativeAssociation(evidence);
  const signedIn = owner();
  const expired = mintSession(teamStore(), signedIn.member.id, "telegram", desktop, Date.now() - 365 * 24 * 3_600_000);
  expect((await decide([1], {}, false, expired.value)).status).toBe(401);
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("self-claimed owners, local passkeys and a different Telegram account cannot approve identity", async () => {
  nativeAssociation(evidence);
  const response = await claimPOST(new NextRequest("http://localhost/api/team/claim", {
    method: "POST", headers: { host: "localhost" }, body: JSON.stringify({ name: "Owner" }),
  }));
  expect(response.status).toBe(200);
  const claimed = { member: teamStore().owner()!, cookie: response.cookies.get(MEMBER_COOKIE)!.value };
  expect((await decide([1], {}, false, claimed.cookie)).status).toBe(403);
  updateRelayStore(store => ({ ...store, relays: [destinationRelay()] }));
  teamStore().updateMember({ ...claimed.member, telegram: { userId: "41", username: null, firstName: null, linkedAt: new Date().toISOString() } });
  const passkey = mintSession(teamStore(), claimed.member.id, "passkey", desktop);
  expect((await decide([1], {}, false, passkey.value)).status).toBe(403);
  teamStore().updateMember({ ...claimed.member, telegram: { userId: "42", username: null, firstName: null, linkedAt: new Date().toISOString() } });
  const wrongOwner = mintSession(teamStore(), claimed.member.id, "telegram", desktop);
  expect((await decide([1], {}, false, wrongOwner.value)).status).toBe(403);
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("a paired-owner session cannot approve when its pairing is unavailable", async () => {
  nativeAssociation(evidence);
  const signedIn = owner();
  updateRelayStore(store => ({ ...store, relays: [] }));
  expect((await decide([1], {}, false, signedIn.cookie)).status).toBe(403);
  expect(nativeAssociation(evidence).status).toBe("waiting");
});

nativeTest("paired-owner authorization is checked before saving and permits genuine approval", () => {
  nativeAssociation(evidence);
  const round = loadSeatRounds()[0]!;
  const input = { reviewId: round.id, chosen: [], comment: "", answers: round.questions!.map(q => ({ questionId: q.id, options: [1] })) };
  expect(() => decidePrototype({ kind: "operator-in-process", authorize: () => { throw new Error("owner authorization unavailable"); } }, null, input)).toThrow("owner authorization unavailable");
  expect(nativeAssociation(evidence).status).toBe("waiting");
  decidePrototype({ kind: "operator-in-process", authorize: () => {} }, null, input, { ...prototypeWorld, orchestrator: () => null });
  expect(nativeAssociation(evidence).status).toBe("approved");
  expect(findSeatRound(round.id)?.decision).toMatchObject({ nativeAssociationApproval: "paired-owner", decidedBy: { kind: "operator" } });
  decidePrototype({ kind: "operator-in-process", authorize: () => {} }, null,
    { ...input, answers: round.questions!.map(q => ({ questionId: q.id, options: [0] })) }, { ...prototypeWorld, orchestrator: () => null });
  expect(nativeAssociation(evidence).status).toBe("refused");
});

nativeTest("legacy operator classification cannot grant identity and needs fresh authenticated approval", async () => {
  nativeAssociation(evidence);
  const signedIn = owner();
  await decideAsOwner([1], {}, signedIn.cookie);
  const round = loadSeatRounds()[0]!;
  const legacyProof = crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  const legacy = structuredClone(round);
  legacy.id = `pr_${legacyProof.slice(0, 32)}`; legacy.inputDigest = legacyProof; legacy.publicationKey = `native-association:${legacyProof}`;
  delete legacy.decision!.nativeAssociationApproval; legacy.decision!.decidedBy = { kind: "operator" };
  expect(nativeAssociationDecisionApproves(legacy.decision)).toBe(false);
  // Neither a legacy decision under the current key nor old evidence binding grants access.
  mutateSeatRound(round.id, held => { delete held.decision!.nativeAssociationApproval; });
  expect(nativeAssociation(evidence).status).toBe("refused");
  expect((await decideAsOwner([1], {}, signedIn.cookie)).status).toBe(200);
  expect(nativeAssociation(evidence).status).toBe("approved");
  clearSeatRoundsForTests(); insertSeatRound(legacy);
  expect(nativeAssociation(evidence).status).toBe("waiting");
  expect(nativeAssociation(evidence).proof).not.toBe(legacyProof);
  expect((await decideAsOwner([1], {}, signedIn.cookie)).status).toBe(200);
  expect(nativeAssociation(evidence).status).toBe("approved");
});

nativeTest("skipping a decision or using a custom answer never approves identity", async () => {
  const signedIn = owner();
  nativeAssociation(evidence);
  expect((await decideAsOwner([], { answers: undefined, skip: true }, signedIn.cookie)).status).toBe(200);
  expect(nativeAssociation(evidence).status).toBe("refused");
  expect((await decideAsOwner([], { comment: "approve", answers: [{ questionId: "identity", options: [], other: true }, { questionId: "evidence", options: [1] }] }, signedIn.cookie)).status).toBe(200);
  expect(nativeAssociation(evidence).status).toBe("refused");
});

nativeTest("presence updates between request, owner approval and retry retain one approved association", async () => {
  const pending = nativeAssociation(evidence);
  const file = path.join(evidence.home, "sessions", `${evidence.pid}.json`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const status of ["idle", "waiting", "busy"]) {
    fs.writeFileSync(file, JSON.stringify({ ...record, status, waitingFor: status === "waiting" ? "user" : null,
      statusUpdatedAt: Date.now(), updatedAt: Date.now() }));
    expect(nativeAssociationCurrent(evidence)).toBe(true);
    if (status === "idle") expect((await decideAsOwner([1])).status).toBe(200);
    const read = readNativeSessionRecord(evidence.home, evidence.pid); if (read.kind !== "record") throw new Error("record");
    const fresh = { ...evidence, recordIdentity: nativeSessionRecord(read.value, evidence.pid)! };
    expect(nativeAssociation(fresh)).toEqual({ status: "approved", proof: pending.proof });
  }
  expect(loadSeatRounds()).toHaveLength(1);
});

for (const field of ["pid", "sessionId", "procStart", "pidDomain", "startedAt", "kind"] as const) {
  nativeTest(`a changed ${field} cannot be approved`, async () => {
    nativeAssociation(evidence);
    const file = path.join(evidence.home, "sessions", `${evidence.pid}.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const changed = { pid: evidence.pid + 1, sessionId: ["77777777", "7777", "4777", "8777", "777777777777"].join("-"),
      procStart: "0", pidDomain: "linux:other:pidns", startedAt: record.startedAt + 1, kind: "bg" };
    fs.writeFileSync(file, JSON.stringify({ ...record, [field]: changed[field] }));
    expect(nativeAssociationCurrent(evidence)).toBe(false);
    expect((await decideAsOwner([1])).status).toBe(409);
    expect(nativeAssociation(evidence).status).toBe("waiting");
  });
}

nativeTest("compaction retains approval and startup or clear ends it", async () => {
  const signedIn = owner();
  nativeAssociation(evidence);
  expect((await decideAsOwner([1], {}, signedIn.cookie)).status).toBe(200);
  const compact = recordNativeHook(evidence.pid, evidence.sessionId, evidence.transcript, "SessionStart", "", {}, "compact");
  expect(compact.generation).toBe(evidence.generationProof);
  expect(nativeAssociationCurrent(evidence)).toBe(true);
  expect(nativeAssociation(evidence).status).toBe("approved");
  for (const source of ["startup", "clear"]) {
    recordNativeHook(evidence.pid, evidence.sessionId, evidence.transcript, "SessionStart", "", {}, source);
    expect(nativeAssociationCurrent(evidence)).toBe(false);
    expect((await decideAsOwner([1], {}, signedIn.cookie)).status).toBe(409);
  }
  expect(nativeAssociationCurrent({ ...evidence, processIdentity: `${process.pid}:0` })).toBe(false);
});
