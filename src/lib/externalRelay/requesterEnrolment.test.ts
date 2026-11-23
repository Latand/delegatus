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
import { createMcpToolService, MemoryMcpReceiptStore, type McpToolResult } from "@/lib/mcp/server";
import { appendTeamEvent, recordMessageAuthor } from "@/lib/team/events";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore, teamStoreFile } from "@/lib/team/store";
import { readAnswerRecord } from "./answers";
import { ExternalRelayError } from "./errors";
import * as client from "./client";
import { knownRelay } from "./knownRelays";
import { elevatedRequesterFor } from "./profile";
import { proposeRequesterOperation, requesterCodeMatch, redactRequesterCodes } from "./requesterEnrolment";
import { requesterBrowserAuthority } from "./requesterEnrolmentHttp";
import { requesterProposalId, type RequesterMcpInput, type RequesterView } from "./requesterEnrolmentContract";
import { requestSchema } from "./protocol";
import { contextRequest } from "./request.fixture";
import { runClaimedRequest } from "./runner";
import { procBackend } from "@/lib/proc";
import { hasRequesterRelayCustody, liveOwnerRelayConversation } from "./ownerAuthority";
import { externalRelayFile, readRelayStore, updateRelayStore, updateRunLedger, type PairedRelay, type RelayTargetSettings, type RunRecord } from "./store";
import { trustedRequesterAuditFile } from "./trustedRequesterStore";
import type { RelayRunEntry } from "./trustedRequesters";

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
  function command(operation: object, revision = 0, headers: Record<string, string> = owner, projectOverride: string | null = project) {
    return POST(req({ operation, revision, project: projectOverride, confirmed: true }, headers));
  }
  const view = (headers: Record<string, string> = owner) => GET(req(undefined, headers, `?relay=${id}&target=${target.id}`));
  return { relay, target, owner, scope, start, view, command, browser };
}

function req(body?: object, headers: Record<string, string> = {}, query = "") {
  return new NextRequest(`${base}/api/external-relay/trusted-requesters${query}`, {
    method: body ? "POST" : "GET", headers: { host: "localhost", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function confirmationId(result: McpToolResult): string {
  const prefix = "/#relay-requester=";
  if (!result.ok || typeof result.confirmationPath !== "string" || !result.confirmationPath.startsWith(prefix)) {
    throw new Error("Expected an MCP requester confirmation link");
  }
  const id = requesterProposalId.safeParse(result.confirmationPath.slice(prefix.length));
  if (!id.success) throw new Error("Invalid MCP requester confirmation ID");
  return id.data;
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
  for (const file of [teamStoreFile(), teamStoreFile() + "-wal", teamStoreFile() + "-shm", trustedRequesterAuditFile(), externalRelayFile("runs")])
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

test("a proposal preview refuses a contested or expired candidate and still shows it for decline", async () => {
  const f = fixture("preview");
  const authorize = requesterBrowserAuthority(req(undefined, f.owner));
  const propose = async (operation: RequesterMcpInput) => {
    const result = await proposeRequesterOperation(operation, "fixture-conversation", authorize);
    if (!("confirmationPath" in result)) throw new Error("Expected a requester proposal");
    return result.confirmationPath.slice("/#relay-requester=".length);
  };
  const preview = (id: string) => GET(req(undefined, f.owner, `?proposal=${id}`));
  const code = (await (await f.command(f.start)).json()).issued.code;
  await matchRequesterCode(f.relay, claim(code, "first"), epoch + 1000);
  const args = { ...f.scope, entryId: (await (await f.view()).json()).pending.id };
  const candidate = { name: "Same Display Name", chatTitle: "Fixture group", at };
  const confirm = await propose({ ...args, action: "confirm" });
  const decline = await propose({ ...args, action: "decline" });
  expect(await (await preview(confirm)).json()).toMatchObject({ status: "candidate", candidate });
  await matchRequesterCode(f.relay, claim(code, "second", "clone", "u2"), epoch + 2000);
  const contested = await preview(confirm);
  expect(contested.status).toBe(409);
  expect(await contested.json()).not.toHaveProperty("candidate");
  expect(await (await preview(decline)).json()).toMatchObject({ operation: { ...args, action: "decline" }, status: "contested", candidate });
  expect((await POST(req({ proposalId: decline, confirmed: true }, f.owner))).status).toBe(200);

  const next = (await (await f.command(f.start)).json()).issued.code;
  await matchRequesterCode(f.relay, claim(next, "third", "clone", "u3"), epoch + 3000);
  const later = { ...f.scope, entryId: (await (await f.view()).json()).pending.id };
  // The proposals outlive the enrolment, so only the candidate's expiry refuses them.
  setSystemTime(epoch + 5000);
  const late = await propose({ ...later, action: "confirm" });
  const lateDecline = await propose({ ...later, action: "decline" });
  setSystemTime(epoch + 600_000);
  expect((await preview(late)).status).toBe(409);
  expect(await (await preview(lateDecline)).json()).toMatchObject({ status: "expired",
    candidate: { name: "Same Display Name", chatTitle: "Fixture group", at } });
  expect((await POST(req({ proposalId: late, confirmed: true }, f.owner))).status).toBe(409);
  expect(readRelayStore().relays[0]!.targets[0]!.requesters?.entries ?? []).toEqual([]);
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
  const proposalId = confirmationId(started);
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
  const declined = await call(owner.token, { ...args, action: "decline" });
  expect(declined).toMatchObject({ ok: true });
  const approve = confirmationId(confirm);
  // The owner approving an agent's confirm sees whom the first message bound.
  const candidate = { name: "Same Display Name", chatTitle: "Fixture group", at };
  const previewed = await GET(req(undefined, f.owner, `?proposal=${approve}`));
  expect(previewed.status).toBe(200);
  expect(await previewed.json()).toEqual({ operation: { ...args, action: "confirm" }, targetName: f.target.name, project,
    label: f.start.label, status: "candidate", candidate });
  expect(await (await GET(req(undefined, f.owner, `?proposal=${confirmationId(declined)}`))).json())
    .toEqual({ operation: { ...args, action: "decline" }, targetName: f.target.name, project, label: f.start.label, status: "candidate", candidate });
  expect((await GET(req(undefined, f.browser("owner"), `?proposal=${approve}`))).status).toBe(403);
  expect((await POST(req({ proposalId: approve, confirmed: true }, f.browser("owner")))).status).toBe(403);
  expect((await f.command({ ...args, action: "confirm" })).status).toBe(200);
  expect((await POST(req({ proposalId: approve, confirmed: true }, f.owner))).status).toBe(409);
  const remove = await call(owner.token, { ...args, action: "remove" });
  expect(remove).toMatchObject({ ok: true });
  const removeId = confirmationId(remove);
  setSystemTime(epoch + 600_000);
  expect((await POST(req({ proposalId: removeId, confirmed: true }, f.owner))).status).toBe(410);
  expect((await f.view()).status).toBe(200);
  recordMessageAuthor({ actor: { kind: "member", memberId: "member" }, conversationId: owner.conversation,
    clientMessageId: "member-turn", text: "Fixture member input" });
  expect(await call(owner.token, list)).toMatchObject({ ok: false });
});

test("an unreadable audit line never blocks removal, and the view keeps the readable history", async () => {
  const f = fixture("damaged-audit");
  const code = (await (await f.command(f.start)).json()).issued.code;
  await matchRequesterCode(f.relay, claim(code, "candidate"), epoch + 1000);
  const entryId = (await (await f.view()).json()).pending.id;
  expect((await f.command({ ...f.scope, action: "confirm", entryId })).status).toBe(200);
  const file = trustedRequesterAuditFile();
  const [started, confirmed] = fs.readFileSync(file, "utf8").trim().split("\n");
  fs.writeFileSync(file, `${started}\n{"time": truncated\nnull\n[1]\n{"action":"unknown","relay":"x"}\n${confirmed}\n`);
  const listed: RequesterView = await (await f.view()).json();
  expect(listed.entries.map(entry => entry.id)).toEqual([entryId]);
  expect(listed.history.map(row => row.action)).toEqual(["confirm", "start_enrolment"]);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await f.command({ ...f.scope, action: "remove", entryId }, 1)).status).toBe(200);
  } finally { warn.mockRestore(); }
  expect(readRelayStore().relays[0]!.targets[0]!.requesters).toEqual({ revision: 2, entries: [] });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  expect(lines).toHaveLength(7);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ action: "remove", entryId, revisionBefore: 1, revisionAfter: 2 });
  const after: RequesterView = await (await f.view()).json();
  expect(after).toMatchObject({ entries: [], revision: 2 });
  expect(after.history.map(row => row.action)).toEqual(["remove", "confirm", "start_enrolment"]);
});

test("another owner session sees that an enrolment is pending, without its id, label or candidate", async () => {
  const f = fixture("other-session");
  const code = (await (await f.command(f.start)).json()).issued.code;
  await matchRequesterCode(f.relay, claim(code, "candidate"), epoch + 1000);
  const own: RequesterView = await (await f.view()).json();
  expect(own).toMatchObject({ pending: { status: "candidate" }, otherSession: null });
  const second = f.browser("owner");
  const response = await f.view(second);
  const text = await response.clone().text();
  const other: RequesterView = await response.json();
  expect(other).toMatchObject({ pending: null, otherSession: { expiresAt: new Date(epoch + 600_000).toISOString() }, canStart: true });
  for (const secret of [own.pending!.id, "Same Display Name", "Fixture group", code]) expect(text.includes(secret)).toBe(false);
  // The owner's own audit history still names the label; the pending state itself carries only its expiry.
  expect(Object.keys(other.otherSession!)).toEqual(["expiresAt"]);
  expect((await f.command(f.start, 0, second)).status).toBe(409);
  expect((await f.command({ ...f.scope, action: "decline", entryId: own.pending!.id }, 0, second)).status).toBe(403);
  setSystemTime(epoch + 600_000);
  expect(await (await f.view(second)).json()).toMatchObject({ pending: { id: own.pending!.id, status: "expired" }, otherSession: null });
});

test("MCP refuses a root conversation that holds an owner relay run or trusted requester custody", async () => {
  const f = fixture("relay-run");
  updateRelayStore(store => ({ ...store, relays: [{ ...f.relay, targets: f.relay.targets.map(target =>
    target.id === "other" ? { ...target, ownerTier: true } : target) }] }));
  const root = rootCapability("relay-run-owner");
  appendTeamEvent(teamStore(), { actor: { kind: "member", memberId: "owner" },
    action: "agent.started", subject: { kind: "conversation", id: root.conversation, title: null } });
  const post = async (_path: string, body: Record<string, unknown>, headers?: Record<string, string>) => {
    const result = await proposal(req(body, headers));
    if (!result.ok) throw new Error(`request refused ${result.status}`);
    return result.json();
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, { post }), new MemoryMcpReceiptStore());
  const call = (body: Record<string, unknown>) => runAsMcpHttpCaller({ capability: root.token }, () => service.callTool("relay_trusted_requesters", body));
  const direct = (body: Record<string, unknown>) => proposal(req(body, { ...internalServiceHeaders("mcp"), [VIEWER_SPAWN_CAPABILITY_HEADER]: root.token }));
  const list = { ...f.scope, action: "list" };
  const run = (requestId: string, entry?: RelayRunEntry): RunRecord => ({
    requestId, leaseId: `${requestId}-lease`, relayId: f.relay.id, targetId: "other", childPid: null, childIdentity: null,
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), runDir: "", startedAt: at,
    conversationId: root.conversation, ownerTurn: { clientAttemptId: `relay-owner-${requestId}`, ...(entry ? { entry } : {}) },
  });
  expect(await call(list)).toMatchObject({ ok: true });
  const cases: [string, RunRecord, () => boolean][] = [
    ["owner run", run("live_owner_run"), () => liveOwnerRelayConversation(root.conversation)],
    ["requester custody", run("requester_custody", { id: "custody-entry", kind: "requester", tier: "requester", project, label: "Fixture requester" }),
      () => hasRequesterRelayCustody(root.conversation)],
  ];
  for (const [name, row, holds] of cases) {
    updateRunLedger(ledger => ({ ...ledger, runs: [row] }));
    expect([name, holds()]).toEqual([name, true]);
    for (const body of [list, f.start]) {
      const refused = await direct(body);
      expect([name, body.action, refused.status]).toEqual([name, body.action, 403]);
      expect(JSON.stringify(await refused.json()).includes("relay-requester=")).toBe(false);
      expect(await call(body)).toMatchObject({ ok: false });
    }
    updateRunLedger(ledger => ({ ...ledger, runs: [] }));
    expect(await call(list)).toMatchObject({ ok: true });
  }
  expect(fs.existsSync(trustedRequesterAuditFile())).toBe(false);
  expect(await (await f.view()).json()).toMatchObject({ pending: null, otherSession: null });
});
