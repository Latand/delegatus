import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { closeAgentRegistryForTests, type RegistryConversation } from "@/lib/agent/registry";
import type { ViewerMcpDomainDependencies } from "@/lib/mcp/bindings";
import type { McpToolResult, McpToolService } from "@/lib/mcp/server";
import { withWorkspaceMcpFence } from "@/lib/mcp/workspaceFence";
import type { Member } from "@/lib/team/contract";
import { resetTeamStoreForTests, teamStore, type TeamStore } from "@/lib/team/store";
import { conversationWorkspacePrincipal, type WorkspacePrincipal } from "@/lib/team/workspacePrincipal";
import { createWorkspace } from "@/lib/team/workspaces";

import { executeOrchestratorRotation, type SeatCommandDependencies, type SeatLaunchAdmission } from "./seatCommand";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent, orchestratorSeatFor } from "./seats";

/**
 * The reach of a project's orchestrator seat across member input and rotation.
 *
 * The workspace fence exists so a member cannot widen their reach through an
 * agent. A member's message to the owner's seat therefore fences the seat. The
 * incident these tests hold: the fenced seat rotated itself, the rotation wrote
 * the member into the successor's durable seat record, and from then on the
 * owner's own messages could never restore the seat's reach.
 */

const AT = "2026-11-11T08:00:00.000Z";
const PROJECT = "proj-a";
const W = `w_${"d".repeat(32)}`;
const SEAT = "conversation_11111111-1111-4111-8111-111111111111";
const previous = process.env.LLV_STATE_DIR;

let sandbox = "";
let store: TeamStore;
let owner: Member;
let member: Member;
let scope: WorkspacePrincipal;
/** What each launched successor's launch profile holds, as the spawn recorded it. */
let launched: Map<string, { workspace: WorkspacePrincipal | null; parent: string }>;
let requests = 0;

function person(id: string, role: Member["role"]): Member {
  const row: Member = { id, name: id, role, status: "active", color: "teal", telegram: null, createdAt: AT, createdBy: "claim", revokedAt: null };
  store.insertMember(row);
  return row;
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "seat-reach-"));
  process.env.LLV_STATE_DIR = sandbox;
  resetTeamStoreForTests();
  store = teamStore();
  owner = person("m_owner", "owner");
  member = person("m_member", "member");
  createWorkspace(store, owner, { id: W, name: "Alpha", projects: [PROJECT] });
  store.putWorkspaceMember(W, member.id, "member", owner.id, AT);
  scope = { memberId: member.id, workspaceId: W };
  launched = new Map();
  requests = 0;
});

afterEach(() => {
  closeAgentRegistryForTests();
  resetTeamStoreForTests();
  if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The registry as the fence reads it: a successor carries the launch profile
    its spawn was given and a parent link to the seat it replaced. */
function lookup(id: string): RegistryConversation | null {
  const row = launched.get(id);
  return { id, engine: "claude", continuityPaths: [], projectOwnership: { project: PROJECT }, generations: [{ path: `${id}.jsonl`,
    launchProfile: emptyLaunchProfile({ cwd: sandbox, project: PROJECT,
      ...(row?.workspace ? { workspace: row.workspace } : {}),
      ...(row ? { parentConversationId: row.parent as `conversation_${string}` } : {}) }) }] } as unknown as RegistryConversation;
}

function designate(conversationId: string, workspace?: WorkspacePrincipal): void {
  const clientRequestId = `designate_${++requests}_0000`;
  beginOrchestratorSeatIntent({ project: PROJECT, mandate: "own the board", clientRequestId, mode: "spawn", telegramGrant: true,
    ...(workspace ? { workspace } : {}), now: AT });
  completeOrchestratorSeatIntent({ project: PROJECT, clientRequestId, conversationId, path: `${conversationId}.jsonl`, now: AT });
}

/** A person's message, as the conversation host admits it before dispatch. */
const writes = (who: Member, conversationId: string) => store.admitConversationMember(conversationId, who.id);

function dependencies(successor: string): SeatCommandDependencies {
  const incumbent = orchestratorSeatFor(PROJECT).active!.conversationId!;
  return {
    resolveProject: project => ({ project, displayName: project }),
    spawn: async (_body, _autonomous, admission?: SeatLaunchAdmission) => {
      launched.set(successor, { workspace: admission?.workspace ?? null, parent: incumbent });
      return { status: 200, body: { ok: true, conversationId: successor, path: `${successor}.jsonl` } };
    },
    deliver: async () => ({ ok: true, outcome: "delivered" }),
    conversationTarget: conversationId => ({ kind: "eligible", conversationId, path: `${conversationId}.jsonl`, cwd: sandbox, project: PROJECT, engine: "claude" }),
    summarizeHandoffs: async () => ({ kind: "fallback", reason: "unavailable" }),
    launchSettlement: () => ({ kind: "unknown" }),
    stampRegistryIdentity: () => {},
    runtimeIdentity: () => ({ engine: null, model: null }),
    resolvedConversation: conversationId => ({ conversationId, path: `${conversationId}.jsonl`, holdsTurns: true, cwd: sandbox }),
    now: () => AT,
  } as SeatCommandDependencies;
}

/** The seat rotates itself through the rotation route's agent admission. */
async function seatRotatesItself(successor: string): Promise<void> {
  const seat = orchestratorSeatFor(PROJECT).active!.conversationId!;
  const answer = await executeOrchestratorRotation({ project: PROJECT, clientRequestId: `rotate_${++requests}_0000` }, dependencies(successor),
    { kind: "agent", conversationId: seat }, { workspace: conversationWorkspacePrincipal(lookup, seat) ?? undefined });
  expect(answer.status).toBe(200);
  expect(orchestratorSeatFor(PROJECT).active?.conversationId).toBe(successor);
}

/** A signed-in person rotates the seat from the interface. */
async function personRotates(who: Member, successor: string): Promise<void> {
  const answer = await executeOrchestratorRotation({ project: PROJECT, clientRequestId: `rotate_${++requests}_0000` }, dependencies(successor),
    { kind: "operator", conversationId: null }, { workspaceMemberId: who.id });
  expect(answer.status).toBe(200);
  expect(orchestratorSeatFor(PROJECT).active?.conversationId).toBe(successor);
}

/** What the seat can reach through the fenced MCP surface. */
async function reach(conversationId: string): Promise<{ telegram: boolean; ownTranscript: boolean }> {
  const fenced = withWorkspaceMcpFence({ callTool: async (tool, _input, context) => {
    const answer = { ok: true, toolName: tool, clientRequestId: null, replayed: false } as McpToolResult;
    context?.assertResult?.(answer);
    return answer;
  } } as McpToolService, {
    attentionAuthority: () => ({ kind: "worker", conversationId, role: "orchestrator" }),
    registrySnapshot: () => ({ conversations: {} }),
    workspaceConversation: lookup,
    workspaceProject: () => PROJECT,
  } as unknown as ViewerMcpDomainDependencies);
  const telegram = await fenced.callTool("telegram_bot_send", { clientRequestId: "telegram-send", chat: "team", text: "status" });
  const transcript = await fenced.callTool("conversation_messages", { clientRequestId: "own-transcript", transcriptPath: `${SEAT}.jsonl` });
  for (const answer of [telegram, transcript]) if (!answer.ok) expect(answer.code).toBe("workspace_forbidden");
  return { telegram: telegram.ok, ownTranscript: transcript.ok };
}

const OWNER_REACH = { telegram: true, ownTranscript: true };
const MEMBER_REACH = { telegram: false, ownTranscript: true };

test("a member's message fences the owner's seat, and the owner's next message restores its reach", async () => {
  designate(SEAT);
  expect(await reach(SEAT)).toEqual(OWNER_REACH);
  writes(member, SEAT);
  expect(await reach(SEAT)).toEqual(MEMBER_REACH);
  writes(owner, SEAT);
  expect(await reach(SEAT)).toEqual(OWNER_REACH);
});

test("a fenced seat's self-rotation stays fenced, and the owner's next message restores the successor's reach", async () => {
  const successor = "conversation_22222222-2222-4222-8222-222222222222";
  designate(SEAT);
  writes(member, SEAT);
  await seatRotatesItself(successor);
  // The member's request travels in the handover, so the successor starts fenced.
  expect(await reach(successor)).toEqual(MEMBER_REACH);
  writes(owner, successor);
  expect(await reach(successor)).toEqual(OWNER_REACH);
  writes(member, successor);
  expect(await reach(successor)).toEqual(MEMBER_REACH);
});

test("the fence follows an unanswered member request through repeated rotations and ends with the owner's message", async () => {
  const second = "conversation_22222222-2222-4222-8222-222222222222";
  const third = "conversation_33333333-3333-4333-8333-333333333333";
  const fourth = "conversation_44444444-4444-4444-8444-444444444444";
  designate(SEAT);
  writes(member, SEAT);
  await seatRotatesItself(second);
  await seatRotatesItself(third);
  expect(await reach(third)).toEqual(MEMBER_REACH);
  writes(owner, third);
  await seatRotatesItself(fourth);
  expect(await reach(fourth)).toEqual(OWNER_REACH);
});

test("the owner's rotation of a member-bound seat designates a seat with the owner's reach", async () => {
  const bound = "conversation_22222222-2222-4222-8222-222222222222";
  const successor = "conversation_33333333-3333-4333-8333-333333333333";
  // The record the incident left behind: seat and launch profile both name the member.
  designate(bound, scope);
  launched.set(bound, { workspace: scope, parent: SEAT });
  writes(owner, bound);
  expect(await reach(bound)).toEqual(MEMBER_REACH);
  await personRotates(owner, successor);
  expect(await reach(successor)).toEqual(OWNER_REACH);
});

test("a seat a member designated keeps the member's reach whatever the owner writes, across its own rotations", async () => {
  const successor = "conversation_22222222-2222-4222-8222-222222222222";
  designate(SEAT);
  await personRotates(member, successor);
  expect(await reach(successor)).toEqual(MEMBER_REACH);
  writes(owner, successor);
  expect(await reach(successor)).toEqual(MEMBER_REACH);
  const third = "conversation_33333333-3333-4333-8333-333333333333";
  await seatRotatesItself(third);
  writes(owner, third);
  expect(await reach(third)).toEqual(MEMBER_REACH);
});
