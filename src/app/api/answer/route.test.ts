import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import type { FileEntry, PendingQuestion } from "@/lib/types";

import { POST } from "./route";

test("a pending answer records one direct operator gesture and excludes internal service traffic", async () => {
  const entry = {
    path: "/sessions/operator-answer-fixture.jsonl",
    root: "claude-projects",
    name: "operator-answer-fixture.jsonl",
    project: "project-fixture",
    title: "fixture",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    derivationComplete: true,
    proc: "running",
    pid: 43,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  const recorded: unknown[] = [];
  const dependencies = {
    knownState: async (_transcriptPath: string, toolUseId: string) => ({
      entry,
      pending: { toolUseId } as PendingQuestion,
      result: null,
    }),
    resolveTarget: async () => "agents:2.0",
    recordOperatorRequest: (_request: unknown, input: unknown) => { recorded.push(input); return null; },
    deliverAnswer: async () => "Continue",
    confirmAnswered: async () => "Continue",
    paneScreen: async () => "",
  };
  const post = (toolUseId: string, headers: Record<string, string> = {}) => POST.withDependencies(
    new NextRequest("http://127.0.0.1/api/answer", {
      method: "POST",
      headers: {
        cookie: `llv_operator=${soloBrowserSession()}`,
        host: "127.0.0.1",
        origin: "http://127.0.0.1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        transcriptPath: entry.path,
        toolUseId,
        kind: "single",
        option: 0,
      }),
    }),
    dependencies,
  );

  const direct = await post("tool-answer-direct-one");
  const synthetic = await post("tool-answer-synthetic-one", internalServiceHeaders("mcp"));

  expect([direct.status, synthetic.status]).toEqual([200, 200]);
  expect(recorded).toEqual([expect.objectContaining({
    path: entry.path,
    idempotencyKey: "question:tool-answer-direct-one",
  })]);
});


for (const writeFails of [false, true]) test(`legacy member answers require durable authority before delivery: ${writeFails}`, async () => {
  const { claimInstall, createInvite, redeemJoin } = await import("@/lib/team/members");
  const { resetTeamStoreForTests, teamStore, TeamStore } = await import("@/lib/team/store");
  const { createWorkspace } = await import("@/lib/team/workspaces");
  const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
  const { sessionKeyFromTranscript } = await import("@/lib/agent/sessionKey");
  const oldState = process.env.LLV_STATE_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "answer-workspace-"));
  process.env.LLV_STATE_DIR = root; resetTeamStoreForTests();
  const write = writeFails ? spyOn(TeamStore.prototype, "admitConversationMember").mockImplementation(() => { throw new Error("fixture write refused"); }) : null;
  try {
    const store = teamStore();
    const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" });
    const workspaceId = `w_${"e".repeat(32)}`;
    createWorkspace(store, owner.member, { id: workspaceId, name: "Alpha", projects: ["project-fixture"] });
    const member = redeemJoin(store, createInvite(store, owner.member, null).code, "Member", { surface: "desktop", browser: "chrome" });
    store.putWorkspaceMember(workspaceId, member.member.id, "member", owner.member.id, "2026-10-20T09:00:00.000Z");
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    setAgentRegistryForTests(registry);
    const sessionId = ["00000000", "0000", "4000", "8000", "000000000031"].join("-");
    const transcriptPath = path.join(root, `${sessionId}.jsonl`);
    const launch = registry.beginSpawn("claude", root, { project: "project-fixture", title: "Answer fixture" });
    registry.completeSpawn(launch.launchId, { key: sessionKeyFromTranscript("claude", transcriptPath)!, artifactPath: transcriptPath,
      cwd: root, accountId: null, status: "idle", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn" });
    let calls = 0;
    const response = await POST.withDependencies(new NextRequest("http://localhost/api/answer", {
      method: "POST", headers: { host: "localhost", "content-type": "application/json", cookie: `llv_member=${member.cookie}` },
      body: JSON.stringify({ transcriptPath, toolUseId: "question", kind: "single", option: 0 }),
    }), {
      knownState: async () => ({ entry: { path: transcriptPath, conversationId: launch.conversationId, pid: 43 } as FileEntry,
        pending: { toolUseId: "question" } as PendingQuestion, result: null }),
      resolveTarget: async () => "fixture-pane",
      recordOperatorRequest: () => null,
      deliverAnswer: async () => {
        calls++;
        expect(store.latestConversationMember(launch.conversationId)).toBe(member.member.id);
        return "Continue";
      },
      confirmAnswered: async () => "Continue", paneScreen: async () => "",
    });
    expect(response.status).toBe(writeFails ? 503 : 200);
    expect(calls).toBe(writeFails ? 0 : 1);
  } finally {
    write?.mockRestore();
    setAgentRegistryForTests(null); resetTeamStoreForTests();
    if (oldState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = oldState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
