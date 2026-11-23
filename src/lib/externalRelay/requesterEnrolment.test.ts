import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import fs from "node:fs";
import { NextRequest } from "next/server";
import { recordOperatorRequest } from "@/lib/activity/requestLedger";
import { GET, POST } from "@/app/api/external-relay/trusted-requesters/route";
import { POST as proposal } from "@/app/api/external-relay/trusted-requesters/proposal/route";
import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { agentRegistry } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { runAsMcpHttpCaller } from "@/lib/mcp/callerContext";
import { viewerMcpBindings } from "@/lib/mcp/bindings";
import { createMcpToolService, MemoryMcpReceiptStore } from "@/lib/mcp/server";
import { appendTeamEvent, recordMessageAuthor } from "@/lib/team/events";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore, teamStoreFile } from "@/lib/team/store";
import { readAnswerRecord } from "./answers";
import { ExternalRelayError } from "./errors";
import * as client from "./client";
import { knownRelay } from "./knownRelays";
import { elevatedRequesterFor } from "./profile";
import { requesterCodeMatch, redactRequesterCodes } from "./requesterEnrolment";
import type { RequesterView } from "./requesterEnrolmentContract";
import { requestSchema } from "./protocol";
import { contextRequest } from "./request.fixture";
import { runClaimedRequest } from "./runner";
import { readRelayStore, updateRelayStore, type PairedRelay, type RelayTargetSettings } from "./store";
import { trustedRequesterAuditFile } from "./trustedRequesterStore";

const epoch = Date.parse("2026-10-01T08:00:00Z");
const at = new Date(epoch).toISOString();
const project = "fixture-project";
const base = "http://localhost";
const device = { surface: "desktop", browser: "chrome" } as const;

function fixture(id: string) {
  setSystemTime(epoch);
  const target: RelayTargetSettings = { id: "clone", name: "Fixture clone", answered_by: "install", fallback: "none",
    enabled: true, engine: "codex", model: "auto", effort: null, project, concurrency: 1, hardCapMinutes: 1 };
  const origin = knownRelay("celestia")!.origin;
  const relay: PairedRelay = { id, origin, name: "Fixture relay", api_base: base, credential: "fixture-transport",
    description: "", owner: { namespace: "telegram", id: "101", display_name: "Owner", handle: null },
    pairedAt: at, paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 },
    targets: [target, { ...target, id: "other" }, { ...target, id: "unassigned", project: null }] };
  updateRelayStore(store => ({ ...store, relays: [relay] }));
  const team = teamStore();
  for (const role of ["owner", "member"] as const) team.insertMember({
    id: role, name: role, role, status: "active", color: "coral", createdAt: at, createdBy: "fixture", revokedAt: null,
    telegram: { userId: role === "owner" ? "101" : "102", username: null, firstName: null, linkedAt: at },
  });
  const browser = (role: string, method: "telegram" | "passkey" = "telegram") => {
    const { value } = mintSession(team, role, method, device);
    return { cookie: `${MEMBER_COOKIE}=${value}` };
  };
  const owner = browser("owner");
  const scope = { relay: id, target: target.id };
  const start = { ...scope, action: "start_enrolment", label: "Build reviewer" };
  function command(operation: object, revision = 0, headers = owner, projectOverride: string | null = project) {
    return POST(req({ operation, revision, project: projectOverride, confirmed: true }, headers));
  }
  const view = (headers = owner) => GET(req(undefined, headers, `?relay=${id}&target=${target.id}`));
  return { relay, target, owner, scope, start, view, command, browser };
}

function req(body?: object, headers: Record<string, string> = {}, query = "") {
  return new NextRequest(`${base}/api/external-relay/trusted-requesters${query}`, {
    method: body ? "POST" : "GET", headers: { host: "localhost", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function claim(text: string, id: string, target = "clone", author = "u1", replyTo = "other_message") {
  return requestSchema.parse({ ...contextRequest, request_id: id, claimed_at: new Date().toISOString(),
    target_id: target, chat: { key: "fixture_group_chat", title: "Fixture group" }, answer: { ...contextRequest.answer, max_chars: 4000 },
    input: { ...contextRequest.input, request_text: text, requester: { ...contextRequest.input.requester, key: author },
      conversation: [{ ...contextRequest.input.conversation[0], id, reply_to: replyTo,
        author: { key: author, name: "Same Display Name", self: false }, text }], respond_to: id },
  });
}

function rootCapability(tag: string, kind: "operator" | "external" = "operator", clientAttemptId?: string) {
  const registry = agentRegistry();
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: "/fixture", origin: { kind }, clientAttemptId,
    launchProfile: emptyLaunchProfile({ cwd: "/fixture", title: "Requester enrolment fixture" }) });
  if (begun.kind !== "created") throw new Error("expected fresh admission");
  const settled = registry.settleSpawn(begun.receipt.launchId, { key: { engine: "codex", sessionId: `${tag}-fixture` },
    artifactPath: `/fixture/${tag}.jsonl`, cwd: "/fixture", accountId: "fixture", status: "live",
    host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
  if (settled.kind !== "settled") throw new Error("expected settled root");
  return { token: registry.rotateSpawnCapabilityForReceipt(begun.receipt.launchId), conversation: settled.conversation.id };
}

function matchRequesterCode(relay: PairedRelay, request: ReturnType<typeof claim>, deadline: number) {
  return requesterCodeMatch(relay, request, deadline)?.(() => true);
}

afterEach(() => {
  setSystemTime();
  resetTeamStoreForTests();
  for (const file of [teamStoreFile(), teamStoreFile() + "-wal", teamStoreFile() + "-shm", trustedRequesterAuditFile()])
    fs.rmSync(file, { force: true });
});

test("runner binds the verified trigger before profile choice and keeps code and grant data off wire and disk", async () => {
  const f = fixture("lifecycle");
  expect(await (await f.view()).json()).toMatchObject({ entries: [], pending: null, revision: 0 });
  expect((await f.command({ ...f.start, target: "unassigned" }, 0, f.owner, null)).status).toBe(400);
  const started = await f.command(f.start);
  expect(started.headers.get("Cache-Control")).toBe("no-store");
  const { issued } = await started.json();
  const code: string = issued.code;
  expect(issued.expiresAt).toBe(new Date(epoch + 600_000).toISOString());
  expect((await f.command(f.start)).status).toBe(409);
  expect(matchRequesterCode(f.relay, claim(code, "wrong_target", "other"), epoch + 10_000)).toBeUndefined();
  expect(matchRequesterCode(f.relay, claim(`word ${code}`, "surrounded"), epoch + 10_000)).toBeUndefined();
  const waiting: RequesterView = await (await f.view()).json();
  expect(waiting.pending).toMatchObject({ status: "waiting", candidate: null });
  const finish = { ...f.scope, action: "confirm", entryId: waiting.pending!.id };
  expect((await f.command(finish)).status).toBe(409);
  const call = spyOn(client, "relayCall").mockResolvedValue({ status: 200, body: {} } as never);
  try {
    const incoming = claim(`@clone ${code} @person`, "first_message");
    const onLaunch = () => { throw new Error("unexpected agent launch"); };
    call.mockRejectedValueOnce(new ExternalRelayError("lease_lost", 409));
    expect(await runClaimedRequest(f.relay, claim(code, "withdrawn"), undefined, { leaseWorker: false })).toBeNull();
    expect((await (await f.view()).json()).pending).toMatchObject({ status: "waiting", candidate: null });
    expect(call.mock.calls.map(call => call[1])).toEqual(["/requests/withdrawn/heartbeat"]);
    call.mockClear();
    expect(await runClaimedRequest(f.relay, incoming, undefined, { leaseWorker: false, ownerPorts: { launch: onLaunch, observe: onLaunch, stop: onLaunch } }))
      .toMatchObject({ outcome: "answered", answer: { action: "reply", text: "Code received. The owner will confirm.", reply_to: "first_message" } });
    expect(call.mock.calls.map(call => call[1])).toEqual(["/requests/first_message/heartbeat", "/requests/first_message/complete"]);
    expect(JSON.stringify(call.mock.calls).includes(code)).toBe(false);
    expect(readAnswerRecord(f.relay.id, f.target.id, "first_message")).toBeNull();
    expect(elevatedRequesterFor(f.relay, f.target, incoming, [f.relay])).toBeNull();
    const candidate = await (await f.view()).json();
    expect(candidate.pending).toEqual({ id: waiting.pending!.id, status: "candidate", label: "Build reviewer",
      expiresAt: issued.expiresAt, candidate: { name: "Same Display Name", chatTitle: "Fixture group", at } });
    expect((await f.command(finish, 0, f.browser("owner"))).status).toBe(403);
    expect((await f.command(finish)).status).toBe(200);
    const current = readRelayStore().relays[0]!;
    expect(elevatedRequesterFor(current, current.targets[0]!, incoming, [current])?.entry).toMatchObject({ id: finish.entryId, tier: "requester", project });
    const impostor = claim("Hello", "impostor", "clone", "u2");
    expect(elevatedRequesterFor(current, current.targets[0]!, impostor, [current])).toBeNull();
    const remove = { ...f.scope, action: "remove", entryId: finish.entryId };
    expect((await f.command(remove)).status).toBe(409);
    expect((await f.command(remove, 1)).status).toBe(200);
    const updated = readRelayStore().relays[0]!;
    expect(elevatedRequesterFor(updated, updated.targets[0]!, incoming, [updated])).toBeNull();
    const audit = fs.readFileSync(trustedRequesterAuditFile(), "utf8");
    expect(audit.includes(code)).toBe(false);
    expect(audit.includes('"key"')).toBe(false);
    expect(audit.includes("Same Display Name")).toBe(false);
    expect(fs.statSync(trustedRequesterAuditFile()).mode & 0o777).toBe(0o600);
    expect(audit.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { time: at, action: "start_enrolment", ...f.scope, project, entryId: finish.entryId, label: f.start.label, approvedBy: "owner", surface: "board", revisionBefore: 0, revisionAfter: 0 },
      { time: at, action: "confirm", ...f.scope, project, entryId: finish.entryId, label: f.start.label, approvedBy: "owner", surface: "board", revisionBefore: 0, revisionAfter: 1 },
      { time: at, action: "remove", ...f.scope, project, entryId: finish.entryId, label: f.start.label, approvedBy: "owner", surface: "board", revisionBefore: 1, revisionAfter: 2 },
    ]);
    expect(redactRequesterCodes({ transcript: [{ text: `old ${code}` }] })).toEqual({ transcript: [{ text: "old [enrolment code]" }] });
  } finally { call.mockRestore(); }
});

test("a fresh second message contests the candidate and the deadline refuses binding at exactly ten minutes", async () => {
  const f = fixture("reuse");
  const code = (await (await f.command(f.start)).json()).issued.code;
  const expected = "This code was already used; ask the owner for a new one.";
  expect(await matchRequesterCode(f.relay, claim(code, "first"), epoch + 1000)).toMatchObject({ message: "first" });
  expect(await matchRequesterCode(f.relay, claim(code, "first"), epoch + 1000)).toMatchObject({ text: "Code received. The owner will confirm." });
  expect(await matchRequesterCode(f.relay, claim(code, "second", "clone", "u2"), epoch + 1000)).toEqual({ message: "second", text: expected });
  let pending = (await (await f.view()).json()).pending;
  expect(pending.status).toBe("contested");
  const finish = { ...f.scope, action: "confirm", entryId: pending.id };
  expect((await f.command(finish)).status).toBe(409);
  expect((await f.command({ ...finish, action: "decline" })).status).toBe(200);
  const replacement = (await (await f.command(f.start)).json()).issued.code;
  setSystemTime(epoch + 600_000);
  expect(await matchRequesterCode(f.relay, claim(replacement, "expired"), epoch + 601_000)).toEqual({ message: "expired", text: expected });
  pending = (await (await f.view()).json()).pending;
  expect(pending).toMatchObject({ status: "expired", candidate: null });
  expect((await f.command({ ...finish, entryId: pending.id })).status).toBe(409);
  expect((await f.command({ ...finish, entryId: pending.id, action: "decline" })).status).toBe(200);
  const audit = await (await f.view()).json();
  expect(audit.history.map((row: { action: string }) => row.action)).toEqual(["decline", "expired", "start_enrolment", "decline", "start_enrolment"]);
});

test("an audit write failure leaves no enrolment or grant and a project change fences confirmation", async () => {
  const f = fixture("changed");
  const auditFile = trustedRequesterAuditFile();
  fs.mkdirSync(auditFile);
  try {
    expect((await f.command(f.start)).status).toBe(500);
  } finally { fs.rmdirSync(auditFile); }
  expect(await (await f.view()).json()).toMatchObject({ pending: null, revision: 0 });
  const first = await f.command(f.start);
  const code = (await first.json()).issued.code;
  await matchRequesterCode(f.relay, claim(code, "before_change"), epoch + 1000);
  const current = (await (await f.view()).json()).pending;
  updateRelayStore(store => ({ ...store, relays: [{ ...f.relay, targets: [{ ...f.target, project: "other-project" }] }] }));
  const confirm = { ...f.scope, action: "confirm", entryId: current.id };
  expect((await f.command(confirm)).status).toBe(409);
  expect((await f.command(confirm, 0, f.owner, "other-project")).status).toBe(409);
  expect(await (await f.view()).json()).toMatchObject({ project: "other-project", pending: { status: "stale" }, entries: [] });
  expect((await f.command({ ...confirm, action: "decline" }, 0, f.owner, "other-project")).status).toBe(200);
});

test("solo operator can withdraw a carried grant and bearer credentials confer no ownership", async () => {
  const f = fixture("solo");
  resetTeamStoreForTests();
  for (const file of [teamStoreFile(), teamStoreFile() + "-wal", teamStoreFile() + "-shm"]) fs.rmSync(file, { force: true });
  updateRelayStore(store => ({ ...store, relays: [{ ...f.relay, targets: [{ ...f.target, ownerTier: true }] }] }));
  const session = soloBrowserSession();
  const solo = { cookie: `llv_operator=${session}` };
  const before: RequesterView = await (await f.view(solo)).json();
  expect(before).toMatchObject({ canStart: false, entries: [{ kind: "paired-owner", active: true }] });
  expect((await f.command(f.start, 0, solo)).status).toBe(403);
  const remove = { ...f.scope, action: "remove", entryId: before.entries[0]!.id };
  expect((await f.command(remove, 0, { authorization: `Bearer ${session}` })).status).toBe(403);
  expect((await f.command(remove, 0, solo)).status).toBe(200);
  expect((await (await f.view(solo)).json()).entries).toEqual([]);
  const rows = fs.readFileSync(trustedRequesterAuditFile(), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => [row.action, row.approvedBy])).toEqual([["earlier-switch", "operator"], ["remove", "operator"]]);
  const attempt = "fixture-authenticated-launch";
  expect(recordOperatorRequest(req(undefined, solo), { kind: "spawn", project, idempotencyKey: `spawn:${attempt}` }))
    .toMatchObject({ author: "operator" });
  const bare = rootCapability("bare-solo");
  const operator = rootCapability("operator-solo", "operator", attempt);
  function readOverMcp(token: string) {
    return proposal(req({ ...f.scope, action: "list" }, { ...internalServiceHeaders("mcp"), [VIEWER_SPAWN_CAPABILITY_HEADER]: token }));
  }
  expect((await readOverMcp(bare.token)).status).toBe(403);
  expect(await (await readOverMcp(operator.token)).json()).toMatchObject({ revision: 1, entries: [] });
});

test("browser scope rejects nonowners, internal services, bearer-only and cross-origin requests", async () => {
  const f = fixture("browser");
  const session = f.browser("owner").cookie.slice(MEMBER_COOKIE.length + 1);
  for (const headers of [{}, f.browser("member"), internalServiceHeaders("mcp"), { ...f.owner, ...internalServiceHeaders("mcp") },
    { authorization: `Bearer ${session}`, "x-llv-operator-token": session }, { ...f.owner, origin: "https://foreign.example" }]) {
    expect((await f.view(headers)).status).toBe(403);
    expect((await f.command(f.start, 0, headers)).status).toBe(403);
  }
  expect((await f.command(f.start, 0, f.browser("owner", "passkey"))).status).toBe(403);
  expect((await POST(req({ operation: f.start, revision: 0, project }, f.owner))).status).toBe(400);
  expect(fs.existsSync(trustedRequesterAuditFile())).toBe(false);
  expect((await f.view({ cookie: `llv_operator=${soloBrowserSession()}` })).status).toBe(403);
});

test("MCP checks the registry origin and proposes single-use browser approval without the code", async () => {
  const f = fixture("mcp");
  function capability(member: "owner" | "member") {
    const root = rootCapability(member);
    appendTeamEvent(teamStore(), { actor: { kind: "member", memberId: member },
      action: "agent.started", subject: { kind: "conversation", id: root.conversation, title: null } });
    return root;
  }
  const owner = capability("owner");
  const teammate = capability("member");
  const unattributed = rootCapability("unattributed");
  const external = rootCapability("external", "external");
  const tagging = internalServiceHeaders("mcp");
  const list = { ...f.scope, action: "list" };
  expect((await proposal(req(list, tagging))).status).toBe(403);
  expect((await proposal(req(list, { [VIEWER_SPAWN_CAPABILITY_HEADER]: owner.token }))).status).toBe(403);
  const post = async (_path: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
    const result = await proposal(req(body, headers));
    if (!result.ok) throw new Error(`request refused ${result.status}`);
    return result.json();
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, { post }), new MemoryMcpReceiptStore());
  const call = (token: string, body: Record<string, unknown>) => runAsMcpHttpCaller({ capability: token }, () => service.callTool("relay_trusted_requesters", body));
  expect(await call(external.token, list)).toMatchObject({ ok: false });
  expect(await call(teammate.token, list)).toMatchObject({ ok: false });
  expect(await call(unattributed.token, list)).toMatchObject({ ok: false });
  expect(await call(teammate.token, f.start)).toMatchObject({ ok: false });
  expect(await call(owner.token, list)).toMatchObject({ ok: true, pending: null, entries: [] });
  const started = await call(owner.token, f.start);
  expect(started).toMatchObject({ ok: true, expiresAt: new Date(epoch + 600_000).toISOString() });
  const proposalId = String(started.confirmationPath).split("=").at(-1);
  expect(await (await f.view()).json()).toMatchObject({ pending: null });
  expect((await POST(req({ proposalId, confirmed: true }, tagging))).status).toBe(403);
  const preview = await GET(req(undefined, f.owner, `?proposal=${proposalId}`));
  expect(await preview.json()).toMatchObject({ operation: f.start, targetName: f.target.name, project });
  const applied = await POST(req({ proposalId, confirmed: true }, f.owner));
  expect(applied.status).toBe(200);
  const code: string = (await applied.json()).issued.code;
  expect(JSON.stringify(started).includes(code)).toBe(false);
  expect((await POST(req({ proposalId, confirmed: true }, f.owner))).status).toBe(410);
  const audit = fs.readFileSync(trustedRequesterAuditFile(), "utf8");
  expect(JSON.parse(audit.trim())).toMatchObject({ approvedBy: "owner", proposingConversation: owner.conversation, surface: "mcp" });
  const pending = (await (await f.view()).json()).pending;
  await matchRequesterCode(f.relay, claim(code, "candidate"), epoch + 1000);
  const args = { ...f.scope, entryId: pending.id };
  const confirm = await call(owner.token, { ...args, action: "confirm" });
  expect(confirm).toMatchObject({ ok: true });
  expect(await call(owner.token, { ...args, action: "decline" })).toMatchObject({ ok: true });
  const approve = String(confirm.confirmationPath).split("=").at(-1);
  expect((await POST(req({ proposalId: approve, confirmed: true }, f.browser("owner")))).status).toBe(403);
  expect((await f.command({ ...args, action: "confirm" })).status).toBe(200);
  expect((await POST(req({ proposalId: approve, confirmed: true }, f.owner))).status).toBe(409);
  const remove = await call(owner.token, { ...args, action: "remove" });
  expect(remove).toMatchObject({ ok: true });
  const removeId = String(remove.confirmationPath).split("=").at(-1);
  setSystemTime(epoch + 600_000);
  expect((await POST(req({ proposalId: removeId, confirmed: true }, f.owner))).status).toBe(410);
  expect((await f.view()).status).toBe(200);
  recordMessageAuthor({ actor: { kind: "member", memberId: "member" }, conversationId: owner.conversation,
    clientMessageId: "member-turn", text: "Fixture member input" });
  expect(await call(owner.token, list)).toMatchObject({ ok: false });
});
