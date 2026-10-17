import { afterAll, expect, setSystemTime, test } from "bun:test";
import { NextRequest } from "next/server";
import fs from "node:fs";
import { reviewPOST } from "@/lib/prototypeReview/http";
import { teamStore, resetTeamStoreForTests } from "@/lib/team/store";
import type { Member } from "@/lib/team/contract";
import { telegramOwnerActor } from "@/lib/team";
import { saveTasks, loadTasks } from "@/lib/tasks/store";
import { insertSeatRound, findSeatRound } from "@/lib/prototypeReview/seatRounds";
import { resetPrototypeDeliveryWorkerForTests } from "@/lib/prototypeReview/deliveryWorker";
import { telegramRound, telegramTask } from "@/lib/prototypeReview/telegram.fixture";
import { prototypeCopyLine } from "@/lib/prototypeReview/telegramAnswer";
import { contextRequest } from "./request.fixture";
import { runClaimedRequest } from "./runner";
import { readAnswerRecord } from "./answers";
import { externalRelayFile, updateRelayStore, type PairedRelay } from "./store";
import { startTestRelay } from "./testRelay";

const at = "2026-10-01T00:00:00.000Z";
const owner: Member = { id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Owner", role: "owner", status: "active", color: "sky",
  telegram: null, createdAt: at, createdBy: "claim", revokedAt: null };
afterAll(async () => { await resetPrototypeDeliveryWorkerForTests(); resetTeamStoreForTests(); setSystemTime(); });

for (const storage of ["task", "seat"] as const) test.each([
  "unlinked", "linked", "conflicting-link", "revoked-owner", "revoked-member", "changed-pairing", "revoked-at-heartbeat",
])(`paired Telegram owner authentication for a ${storage} form: %s`, async scenario => {
  setSystemTime(new Date(at));
  const telegram = (userId: string) => ({ userId, username: null, firstName: null, linkedAt: at });
  const currentOwner: Member = { ...owner,
    telegram: scenario === "linked" ? telegram("111111") : scenario === "conflicting-link" ? telegram("222222") : null,
    ...(scenario === "revoked-owner" ? { status: "revoked", revokedAt: at } : {}) };
  if (teamStore().member(owner.id)) teamStore().updateMember(currentOwner);
  else teamStore().insertMember(currentOwner);
  const member: Member = { ...owner, id: "m_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "Member", role: "member", status: "revoked", revokedAt: at,
    telegram: scenario === "revoked-member" ? telegram("111111") : null };
  if (teamStore().member(member.id)) teamStore().updateMember(member);
  else teamStore().insertMember(member);
  const round = { ...telegramRound(`paired-owner-${storage}-${scenario}`), project: `project-${storage}` };
  if (storage === "task") saveTasks([{ ...telegramTask([round]), project: round.project }]);
  else { round.taskId = null; insertSeatRound(round); }
  const completions: unknown[] = [];
  const server = await startTestRelay((req, body) => {
    if (scenario === "revoked-at-heartbeat" && req.url?.endsWith("/heartbeat"))
      teamStore().updateMember({ ...currentOwner, status: "revoked", revokedAt: at });
    if (req.url?.endsWith("/complete")) completions.push(body);
    return { body: { status: "ok" } };
  });
  const paired: PairedRelay = { id: "paired-owner", origin: server.origin, api_base: `${server.origin}/v1`, name: "Test", description: "",
    credential: "x".repeat(43), owner: { namespace: "telegram", id: "111111", display_name: "Owner", handle: null }, pairedAt: at, paused: false,
    limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true,
      engine: "codex", model: "auto", effort: "low", project: null, concurrency: 1, hardCapMinutes: 1 }] };
  updateRelayStore(store => ({ ...store, relays: [scenario === "changed-pairing" ? { ...paired, owner: { ...paired.owner, id: "222222" } } : paired] }));
  const text = prototypeCopyLine(round);
  const request = { ...contextRequest, request_id: `paired-owner-${storage}-${scenario}`, answer: { ...contextRequest.answer, max_chars: 4000 }, input: { ...contextRequest.input,
    requester: { ...contextRequest.input.requester, is_owner: true }, conversation: contextRequest.input.conversation.map(m => ({ ...m, text })) } };
  try {
    const result = await runClaimedRequest(paired, request, undefined, { command: "/missing-agent" });
    expect(result).toMatchObject({ outcome: "answered", answer: { action: "reply", reply_to: "m1" } });
    expect(completions).toHaveLength(1);
    const decision = storage === "task" ? loadTasks()[0]!.prototypeReviews![0]!.decision : findSeatRound(round.id)!.decision;
    if (scenario === "unlinked" || scenario === "linked") {
      expect(result?.outcome === "answered" && result.answer.text).toContain("✅ Записав");
      expect(decision).toMatchObject({ decidedBy: { kind: "member", memberId: owner.id }, telegramUserId: "111111", originalReply: text, revision: 1 });
    } else {
      expect(result?.outcome === "answered" && result.answer.text).toContain("Цей Telegram-акаунт не має чинного доступу до команди");
      expect(decision).toBeUndefined();
    }
    expect(teamStore().member(owner.id)!.telegram).toEqual(currentOwner.telegram);
    expect(readAnswerRecord(paired.id, "target_1", request.request_id)?.delivery).toBe("accepted");
  } finally { await server.close(); }
});

test("Telegram and member headers grant no web decision identity", async () => {
  teamStore().updateMember(owner);
  const round = telegramRound("forged-web-identity");
  saveTasks([telegramTask([round])]);
  for (const [key, value] of [["x-telegram-user-id", "111111"], ["x-llv-member-id", owner.id], ["authorization", "Bearer 111111"]]) {
    const response = await reviewPOST(new NextRequest("http://localhost/api/tasks/task-prototype/prototypes", {
      method: "POST", headers: { host: "localhost", [key]: value }, body: JSON.stringify({ reviewId: round.id, chosen: [], skip: true, comment: "" }),
    }), "task-prototype");
    expect(response.status).toBe(401);
    expect(loadTasks()[0]!.prototypeReviews![0]!.decision).toBeUndefined();
  }
});

test("pairing authority is read without creating, pruning or repairing settings", () => {
  teamStore().updateMember(owner);
  const file = externalRelayFile("relays");
  const original = fs.readFileSync(file);
  try {
    const settings = JSON.parse(original.toString());
    settings.pending = [{ expires_at: "2000-01-01T00:00:00Z" }];
    const bytes = JSON.stringify(settings);
    fs.writeFileSync(file, bytes);
    expect(telegramOwnerActor("111111")).toEqual({ kind: "member", memberId: owner.id });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    for (const bytes of ["{broken", JSON.stringify({ v: 1, relays: [null], pending: [] })]) {
      fs.writeFileSync(file, bytes);
      expect(telegramOwnerActor("111111")).toBeNull();
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    }
    fs.rmSync(file);
    expect(telegramOwnerActor("111111")).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  } finally { fs.writeFileSync(file, original); }
});
