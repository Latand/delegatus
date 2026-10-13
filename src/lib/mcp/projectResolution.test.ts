import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, agentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { externalRelayFile, writeRelayFile } from "@/lib/externalRelay/store";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { procBackend } from "@/lib/proc";
import { persistProjectAliases } from "@/lib/projects/aliases";
import { projectForCwd } from "@/lib/scanner/describe";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpRecoverableTools, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";

let directory: string;
let previousState: string | undefined;
let registry: AgentRegistry;
const releases: Array<() => void> = [];
const stores: SqliteMcpReceiptStore[] = [];
beforeEach(() => {
  previousState = process.env.LLV_STATE_DIR;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-resolution-"));
  process.env.LLV_STATE_DIR = path.join(directory, "state");
  registry = new AgentRegistry(path.join(directory, "registry.json"));
  setAgentRegistryForTests(registry);
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const store of stores.splice(0)) store.close();
  registry.close();
  setAgentRegistryForTests(null);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(directory, { recursive: true, force: true });
});

function seat(project: string, name: string, conversationId = "conversation_target") {
  expect(persistProjectAliases([{ source: `${project}-old`, target: project, displayName: name }])).toBe(true);
  beginOrchestratorSeatIntent({ project, mandate: "Own this board", clientRequestId: `seat-${conversationId}`, mode: "spawn", promptVersion: null });
  completeOrchestratorSeatIntent({ project, clientRequestId: `seat-${conversationId}`, conversationId, path: null });
}

function harness(owner = false, members: Array<{ project: string; projectName?: string }> | null = [], overrides: Partial<ViewerMcpDomainDependencies> = {}) {
  const registry = agentRegistry();
  const caller = registry.ensureConversation("codex", "/sessions/source.jsonl", null);
  if (owner) {
    writeRelayFile(externalRelayFile("relays"), { v: 1, relays: [{ id: "relay", paused: false, targets: [{ id: "target", enabled: true, ownerTier: true }] }] });
    writeRelayFile(externalRelayFile("runs"), { v: 1, runs: [{
      requestId: "owner-request", relayId: "relay", targetId: "target", conversationId: caller.id,
      ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid),
      ownerTurn: { request: { text: "Hand this request to the project's seat", requestText: null } },
    }] });
  }
  let scans = 0;
  const held = new Promise<never>((resolve) => releases.push(() => resolve(undefined as never)));
  const domain: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    registrySnapshot: () => registry.readOnlySnapshot(),
    authorizedSeats: () => owner ? [] : [{ conversationId: caller.id, path: "/sessions/source.jsonl", project: "source-project" }],
    attentionAuthority: () => ({ kind: "worker", conversationId: caller.id, role: "orchestrator" }),
    callerAttribution: () => ({ kind: "agent", conversationId: caller.id, role: "orchestrator" }),
    recoveryPredecessors: () => [],
    lastCompletedCatalog: () => null,
    catalogMemberProjects: async () => members,
    completedFileScan: async () => { scans += 1; return held; },
    ...overrides,
  };
  const posts: Array<{ pathname: string; body: Record<string, unknown> }> = [];
  const control = { post: async (pathname: string, body: Record<string, unknown>) => {
    posts.push({ pathname, body });
    return { ok: true, outcome: "delivered", operationId: "fixture-operation" };
  } };
  const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
  stores.push(receipts);
  const service = createMcpToolService(viewerMcpBindings(undefined, control, domain), receipts, undefined, { recovery: viewerMcpRecoverableTools(domain) });
  let sequence = 0;
  const call = async (tool: string, project: string) => {
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = performance.now();
    try {
      const result = await Promise.race([
        service.callTool(tool as "get_orchestrator", { project, text: "Synthetic handoff", ...(tool === "bridge_directive" ? { rootTurnId: "fixture-turn", utterance: 1, instruction: "Synthetic handoff" } : {}), clientRequestId: `resolve-${++sequence}` }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("project lookup exceeded one second")), 900); }),
      ]);
      expect(performance.now() - startedAt).toBeLessThan(1000);
      return result;
    } finally { clearTimeout(timer!); }
  };
  return { service, call, posts, scans: () => scans, receipts };
}

for (const route of ["get_orchestrator", "send_message_to_orchestrator", "owner-relay"] as const) {
  const tool = route === "owner-relay" ? "send_message_to_orchestrator" : route;
  test(`${route} resolves case and whitespace without a completed scan`, async () => {
    seat("target-project", "Example Board");
    const h = harness(route === "owner-relay", null);
    for (const project of ["  eXaMpLe BoArD  ", " TARGET-PROJECT "]) {
      expect(await h.call(tool, project)).toMatchObject({ ok: true, project: "target-project" });
    }
    expect(h.scans()).toBe(0);
    if (route !== "get_orchestrator") {
      expect(h.posts.map(p => p.body.conversationId)).toEqual(["conversation_target", "conversation_target"]);
      if (route === "owner-relay") expect(h.receipts.lookup("send_message_to_orchestrator:resolve-1")).toMatchObject({ binding: { sendPayload: { origin: { role: "owner-relay" } } } });
    }
  });

  test(`${route} resolves the repository directory name independently of its display name`, async () => {
    const root = path.join(directory, "WidgetsRepo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/RemoteWidgets.git\n');
    const project = projectForCwd(root)!;
    seat(project, "Example Board");
    const h = harness(route === "owner-relay", null, { lastCompletedCatalog: () => ({ files: [], projectCatalog: [{ project, displayName: "Example Board", projectRoot: root, smt: 1, conversations: 1 }] }) });
    expect(await h.call(tool, "  wIDGETSrEPO  ")).toMatchObject({ ok: true, project });
    expect(h.scans()).toBe(0);
  });

  for (const secondName of ["Example Board", "EXAMPLE BOARD"]) {
    test(`${route} refuses an ambiguous name (${secondName}) immediately with both candidates`, async () => {
      seat("target-project", "Example Board");
      seat("second-project", secondName, "conversation_second");
      const h = harness(route === "owner-relay");
      const result = await h.call(tool, " Example Board ");
      expect(result).toMatchObject({ ok: false, code: "ambiguous_project", retryable: false, details: { candidates: ["second-project", "target-project"] } });
      expect("error" in result && result.error).toBe('ambiguous project "Example Board": second-project, target-project; pass one of these project keys');
      expect(h.posts).toEqual([]);
      expect(h.receipts.lookup(`${tool}:resolve-1`)).toBeNull();
      expect(h.scans()).toBe(0);
    });
  }

  test(`${route} refuses an unknown name immediately with close matches`, async () => {
    seat("target-project", "Example Board");
    const h = harness(route === "owner-relay");
    const result = await h.call(tool, " Example Boar ");
    expect(result).toMatchObject({ ok: false, code: "unknown_project", retryable: false, details: { closeMatches: [{ project: "target-project", name: "Example Board" }] } });
    expect("error" in result && result.error).toBe('no such project "Example Boar"; close matches: Example Board (target-project)');
    expect(h.posts).toEqual([]);
    expect(h.scans()).toBe(0);
  });
}

for (const route of ["get_orchestrator", "send_message_to_orchestrator", "owner-relay"] as const) {
  test(`${route} refuses a folded key that collides with another project's display name`, async () => {
    seat("atlas", "Atlas", "conversation_atlas");
    seat("named-project", "ATLAS", "conversation_named");
    const h = harness(route === "owner-relay", null);
    const tool = route === "owner-relay" ? "send_message_to_orchestrator" : route;
    const result = await h.call(tool, " ATLAS ");
    expect(result).toMatchObject({ ok: false, code: "ambiguous_project", retryable: false,
      details: { candidates: ["atlas", "named-project"] } });
    expect("error" in result && result.error).toBe('ambiguous project "ATLAS": atlas, named-project; pass one of these project keys');
    expect(h.posts).toEqual([]);
    expect(h.receipts.lookup(`${tool}:resolve-1`)).toBeNull();
    expect(h.scans()).toBe(0);
  });
}

test("a recovered worktree lookalike name addresses only its canonical parent seat", async () => {
  seat("lookalike-project", "Parent Board lane", "conversation_lookalike");
  seat("parent-project", "Parent Board", "conversation_parent");
  expect(persistProjectAliases([{ source: "lookalike-project", target: "parent-project", displayName: "Parent Board" }])).toBe(true);
  const h = harness(false, [{ project: "lookalike-project", projectName: "Parent Board lane" }]);
  const result = await h.call("send_message_to_orchestrator", " parent board LANE ");
  expect(result).toMatchObject({ ok: true, project: "parent-project", conversationId: "conversation_parent" });
  expect(h.posts.map(p => p.body.conversationId)).toEqual(["conversation_parent"]);
});

for (const route of ["get_orchestrator", "send_message_to_orchestrator", "owner-relay"] as const) {
  test(`${route} preserves a verified project owner when another retained cwd names a foreign worktree`, async () => {
    const alphaRoot = path.join(directory, "AlphaRepo");
    const betaRoot = path.join(directory, "BetaRepo");
    for (const root of [alphaRoot, betaRoot]) {
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    fs.writeFileSync(path.join(alphaRoot, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/AlphaRemote.git\n');
    fs.writeFileSync(path.join(betaRoot, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/BetaRemote.git\n');
    const alpha = projectForCwd(alphaRoot)!;
    const betaWorktree = path.join(betaRoot, "worktrees", "deleted-lane");
    seat(alpha, "Alpha Board", "conversation_alpha");
    seat(projectForCwd(betaRoot)!, "Beta Board", "conversation_beta");
    const snapshot = {
      conversations: {
        conversation_alpha: { id: "conversation_alpha", projectOwnership: { project: alpha, source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" }, generations: [{ launchProfile: { cwd: alphaRoot } }], continuityPaths: [] },
        conversation_beta: { id: "conversation_beta", projectOwnership: { project: projectForCwd(betaRoot), source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" }, generations: [{ launchProfile: { cwd: betaRoot } }], continuityPaths: [] },
        conversation_alpha_root: {
          id: "conversation_alpha_root",
          projectOwnership: { project: alpha, source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" },
          generations: [{ launchProfile: { cwd: alphaRoot } }], continuityPaths: [],
        },
        conversation_alpha_foreign_cwd: {
          id: "conversation_alpha_foreign_cwd",
          projectOwnership: { project: alpha, source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" },
          generations: [{ launchProfile: { cwd: betaWorktree } }], continuityPaths: [],
        },
      },
      conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {},
    };
    fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
    fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { [alpha]: "github.com/team/AlphaRemote" } }));
    const h = harness(route === "owner-relay", null, { registrySnapshot: () => snapshot as never });
    const tool = route === "owner-relay" ? "send_message_to_orchestrator" : route;
    for (const name of [alpha, "Alpha Board", "AlphaRepo", "AlphaRemote"]) {
      const result = await h.call(tool, name);
      if (result.ok) expect(result).toMatchObject({ project: alpha, ...(tool === "get_orchestrator" ? {} : { conversationId: "conversation_alpha" }) });
      else expect(result).toMatchObject({ code: "ambiguous_project", details: { candidates: [alpha, projectForCwd(betaRoot)] } });
    }
    expect(h.posts.every(post => post.body.conversationId !== "conversation_beta")).toBe(true);
    expect(h.scans()).toBe(0);
  });
}

for (const route of ["get_orchestrator", "send_message_to_orchestrator", "owner-relay"] as const) {
  for (const alphaFirst of [true, false]) {
    test(`${route} refuses conflicting deleted-worktree parents independent of registry order`, async () => {
      const alphaRoot = path.join(directory, "AlphaRepo");
      const betaRoot = path.join(directory, "BetaRepo");
      for (const root of [alphaRoot, betaRoot]) {
        fs.mkdirSync(path.join(root, ".git"), { recursive: true });
        fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      }
      fs.writeFileSync(path.join(alphaRoot, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/AlphaRemote.git\n');
      fs.writeFileSync(path.join(betaRoot, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/BetaRemote.git\n');
      const alpha = projectForCwd(alphaRoot)!;
      const beta = projectForCwd(betaRoot)!;
      seat(alpha, "Alpha Board", "conversation_alpha");
      seat(beta, "Beta Board", "conversation_beta");
      const owner = "lookalike-project";
      const alphaRow = { id: "conversation_stale_alpha", projectOwnership: { project: owner, source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" }, generations: [{ launchProfile: { cwd: path.join(alphaRoot, "worktrees", "deleted-alpha") } }], continuityPaths: [] };
      const betaRow = { id: "conversation_stale_beta", projectOwnership: { project: owner, source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" }, generations: [{ launchProfile: { cwd: path.join(betaRoot, "worktrees", "deleted-beta") } }], continuityPaths: [] };
      const snapshot = { conversations: Object.fromEntries((alphaFirst ? [alphaRow, betaRow] : [betaRow, alphaRow]).map(row => [row.id, row])), conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {} };
      const h = harness(route === "owner-relay", null, {
        registrySnapshot: () => snapshot as never,
        lastCompletedCatalog: () => ({ files: [], projectCatalog: [{ project: owner, displayName: "Shared lane", smt: 2, conversations: 2 }] }),
      });
      const tool = route === "owner-relay" ? "send_message_to_orchestrator" : route;
      const result = await h.call(tool, " Shared lane ");
      const candidates = [alpha, beta].sort();
      expect(result).toMatchObject({ ok: false, code: "ambiguous_project", retryable: false, details: { candidates } });
      expect("error" in result && result.error).toBe(`ambiguous project "Shared lane": ${candidates.join(", ")}; pass one of these project keys`);
      expect(h.posts).toEqual([]);
      expect(h.receipts.lookup(`${tool}:resolve-1`)).toBeNull();
      expect(h.scans()).toBe(0);
    });
  }
}

for (const tool of ["rotate_orchestrator", "seat_tick_settings", "create_orchestrator", "ask_orchestrator_in_parallel", "bridge_directive"] as const) {
  test(`${tool} resolves a named project before its control or settings operation`, async () => {
    seat("target-project", "Example Board");
    const h = harness(false, [], tool === "bridge_directive" ? { callerAttribution: () => ({ kind: "gateway", conversationId: "conversation_gateway", role: null }), authorizedSeats: () => [{ project: "target-project", conversationId: "conversation_target", path: null }] } : {});
    const result = await h.call(tool, " eXAMPLE bOARD ");
    // The operation receives the canonical project after name admission.
    expect(result.ok).toBe(true);
    expect(h.scans()).toBe(0);
    for (const post of h.posts) {
      if (tool === "bridge_directive") expect(post.body.conversationId).toBe("conversation_target");
      else expect(post.body.project).toBe("target-project");
    }
  });
}

test("create_task stores the canonical project for a named board", async () => {
  seat("target-project", "Example Board");
  const h = harness();
  const result = await h.service.callTool("create_task", { project: " eXAMPLE bOARD ", text: "Synthetic task", crossProjectRequest: "Create this task on that board", clientRequestId: "named-task" });
  expect(result).toMatchObject({ ok: true, task: { project: "target-project" } });
  expect(h.scans()).toBe(0);
});

for (const tool of ["spawn_agent", "create_pipeline"] as const) {
  test(`${tool} resolves names before enforcing agreement with its directory`, async () => {
    const root = path.join(directory, "WidgetsRepo");
    fs.mkdirSync(root);
    seat(projectForCwd(root)!, "Example Board");
    const h = harness();
    const args = tool === "spawn_agent" ? { cwd: root, prompt: "Synthetic", engine: "codex", role: "builder" }
      : { repoDir: root, task: "Synthetic", stages: [], src: "/sessions/source.jsonl", autoStart: false };
    const result = await h.service.callTool(tool, { ...args, project: " eXAMPLE bOARD ", crossProjectRequest: "Do this work here", clientRequestId: "named-launch" });
    expect("error" in result && result.error).not.toContain("project contradicts");
    if (tool === "spawn_agent") expect(h.posts[0]?.pathname).toBe("/api/spawn");
    const refused = await h.service.callTool(tool, { ...args, project: " Example Boar ", clientRequestId: "unknown-launch" });
    expect(refused).toMatchObject({ ok: false, code: "unknown_project", retryable: false });
    expect(h.scans()).toBe(0);
  });
}


test("a stale directory lookalike with a deleted worktree root is never the recipient", async () => {
  const root = path.join(directory, "ParentRepo");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const parent = projectForCwd(root)!;
  seat("lookalike-project", "ParentRepo lane", "conversation_lookalike");
  seat(parent, "Parent Board", "conversation_parent");
  const checkout = path.join(root, "worktrees", "gone-lane");
  const h = harness(false, null, { lastCompletedCatalog: () => ({ files: [], projectCatalog: [{ project: "lookalike-project", displayName: "ParentRepo lane", projectRoot: checkout, smt: 1, conversations: 1 }] }) });
  const result = await h.call("send_message_to_orchestrator", " PARENTREPO LANE ");
  if (result.ok) expect(result).toMatchObject({ project: parent, conversationId: "conversation_parent" });
  else expect(result).toMatchObject({ code: "ambiguous_project" });
  expect(h.posts.every(post => post.body.conversationId !== "conversation_lookalike")).toBe(true);
  expect(h.scans()).toBe(0);
});

for (const route of ["send_message_to_orchestrator", "owner-relay"] as const) {
  test(`${route} canonicalizes stale registry ownership from a deleted nested worktree cwd`, async () => {
    const root = path.join(directory, "ParentRepo");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    const checkout = path.join(root, "worktrees", "deleted-lane");
    const parent = projectForCwd(checkout)!;
    seat("lookalike-project", "ParentRepo lane", "conversation_lookalike");
    seat(parent, "ParentRepo", "conversation_parent");
    const snapshot = {
      conversations: {
        conversation_stale: {
          id: "conversation_stale",
          projectOwnership: { project: "lookalike-project", source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" },
          generations: [{ launchProfile: { cwd: checkout } }], continuityPaths: [],
        },
      },
      conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {},
    };
    const h = harness(route === "owner-relay", null, { registrySnapshot: () => snapshot as never });
    expect(await h.call("get_orchestrator", " PARENTREPO LANE ")).toMatchObject({ ok: true, project: parent, designated: true });
    const result = await h.call("send_message_to_orchestrator", " PARENTREPO LANE ");
    expect(result).toMatchObject({ ok: true, project: parent, conversationId: "conversation_parent" });
    expect(h.posts.map(post => post.body.conversationId)).toEqual(["conversation_parent"]);
    expect(h.receipts.lookup("send_message_to_orchestrator:resolve-2")).not.toBeNull();
    expect(h.scans()).toBe(0);
  });
}

for (const route of ["get_orchestrator", "send_message_to_orchestrator", "owner-relay"] as const) {
  for (const cwdFirst of [false, true]) {
    test(`${route} finds repository directory evidence after ${cwdFirst ? "cwd" : "ownership-only"} row order`, async () => {
      const root = path.join(directory, "WidgetsRepo");
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(path.join(root, ".git", "config"), '[remote "origin"]\nurl = https://example.invalid/team/RemoteWidgets.git\n');
      const project = projectForCwd(root)!;
      seat(project, "Example Board");
      const ownershipOnly = {
        id: "conversation_owner_only",
        projectOwnership: { project, source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" },
        generations: [], continuityPaths: [],
      };
      const cwdEvidence = {
        id: "conversation_cwd_evidence",
        generations: [{ launchProfile: { cwd: root } }], continuityPaths: [],
      };
      const rows = cwdFirst ? [cwdEvidence, ownershipOnly] : [ownershipOnly, cwdEvidence];
      const snapshot = { conversations: Object.fromEntries(rows.map(row => [row.id, row])), conversationAliases: {}, lineageEdges: {}, memberships: {}, receipts: {} };
      const h = harness(route === "owner-relay", null, { registrySnapshot: () => snapshot as never });
      const tool = route === "owner-relay" ? "send_message_to_orchestrator" : route;
      const result = await h.call(tool, " wIDGETSrEPO ");
      expect(result).toMatchObject({ ok: true, project });
      if (tool === "send_message_to_orchestrator") expect(h.posts.map(post => post.body.conversationId)).toEqual(["conversation_target"]);
      expect(h.scans()).toBe(0);
    });
  }
}

for (const route of ["get_orchestrator", "send_message_to_orchestrator", "owner-relay"] as const) {
  test(`${route} refuses case-colliding project keys before selecting a seat`, async () => {
    seat("CaseProject", "First Board", "conversation_first");
    seat("caseproject", "Second Board", "conversation_second");
    const h = harness(route === "owner-relay");
    expect(await h.call(route === "owner-relay" ? "send_message_to_orchestrator" : route, " CaseProject ")).toMatchObject({ ok: false, code: "ambiguous_project", details: { candidates: ["CaseProject", "caseproject"] } });
    expect(h.posts).toEqual([]);
    expect(h.scans()).toBe(0);
  });
}


test("a fresh name lookup after succession selects the current seat", async () => {
  seat("target-project", "Example Board", "conversation_retired");
  const h = harness();
  expect(await h.call("send_message_to_orchestrator", "Example Board")).toMatchObject({ ok: true, conversationId: "conversation_retired" });
  seat("target-project", "Example Board", "conversation_successor");
  expect(await h.call("send_message_to_orchestrator", " EXAMPLE BOARD ")).toMatchObject({ ok: true, conversationId: "conversation_successor" });
  expect(h.posts.map(post => post.body.conversationId)).toEqual(["conversation_retired", "conversation_successor"]);
});

test("retained registry history keeps a cold name lookup within one second", async () => {
  seat("target-project", "Example Board");
  const parentRoot = path.join(directory, "ParentRepo");
  fs.mkdirSync(path.join(parentRoot, ".git"), { recursive: true });
  fs.writeFileSync(path.join(parentRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "target-project": "github.com/team/example-board" } }));
  registry.ensureConversation("codex", "/sessions/history.jsonl", null);
  const original = registry.readOnlySnapshot();
  const template = Object.values(original.conversations)[0]!;
  const snapshot = { ...original, conversations: Object.fromEntries(Array.from({ length: 30_000 }, (_, index) => [
    `conversation_history_${index}`, { ...template, projectOwnership: { project: "target-project", source: "operator", setAt: "2026-10-13T00:00:00.000Z", operationId: "fixture" },
      generations: [{ launchProfile: { cwd: path.join(parentRoot, "worktrees", `deleted-lane-${index}`) } }] },
  ])) as typeof original.conversations };
  const h = harness(false, null, { registrySnapshot: () => snapshot });
  expect(await h.call("get_orchestrator", " EXAMPLE BOARD ")).toMatchObject({ ok: true, project: "target-project" });
  expect(h.scans()).toBe(0);
});


for (const tool of ["spawn_agent", "create_pipeline"] as const) {
  test(`${tool} replays a named-project receipt after the display name changes`, async () => {
    const root = path.join(directory, "WidgetsRepo");
    fs.mkdirSync(root);
    const project = projectForCwd(root)!;
    seat(project, "Example Board");
    const h = harness();
    const args = tool === "spawn_agent" ? { cwd: root, prompt: "Synthetic", engine: "codex", role: "builder" }
      : { repoDir: root, task: "Synthetic", stages: [], src: "/sessions/source.jsonl", autoStart: false };
    const request = { ...args, project: "Example Board", crossProjectRequest: "Do this work here", clientRequestId: "name-replay" };
    const first = await h.service.callTool(tool, request);
    expect(h.receipts.lookup(`${tool}:name-replay`)).not.toBeNull();
    const count = h.posts.length;
    expect(persistProjectAliases([{ source: `${project}-old`, target: project, displayName: "Renamed Board" }])).toBe(true);
    const replay = await h.service.callTool(tool, request);
    expect(replay).toMatchObject({ ok: first.ok, replayed: true });
    if (!first.ok) expect(replay).toMatchObject({ code: first.code });
    expect(h.posts).toHaveLength(count);
  });
}
