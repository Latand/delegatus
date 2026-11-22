import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { beginOrchestratorSeatIntent, completeOrchestratorSeatIntent } from "@/lib/orchestrator/seats";
import { canonicalProject, persistProjectAliases } from "@/lib/projects/aliases";
import { replaceConversationCatalog, type ConversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import { selectSchemeWindow } from "@/lib/scanner/schemeWindow";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import type { Member } from "@/lib/team/contract";
import { createWorkspace } from "@/lib/team/workspaces";

import { GET } from "./route";

const project = "repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const formerProject = "repo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const foreignProject = "repo-cccccccccccccccccccccccccccccccc";
const conversationId = "conversation_old_seat";
const timestamp = "2026-01-01T00:00:00.000Z";
const route = "http://localhost/api/orchestrator/seat/transcript";
const previousState = process.env.LLV_STATE_DIR;
const previousClaude = process.env.LLV_CLAUDE_HOME;
let sandbox: string;
let transcriptRoot: string;
let seatPath: string;
let registry: AgentRegistry;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "seat-transcript-"));
  process.env.LLV_STATE_DIR = path.join(sandbox, "state");
  process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
  registry = new AgentRegistry(path.join(sandbox, "state", "registry.json"));
  setAgentRegistryForTests(registry);
  transcriptRoot = path.join(sandbox, "claude", "projects", "fixture");
  fs.mkdirSync(transcriptRoot, { recursive: true });
  seatPath = path.join(transcriptRoot, "old-seat.jsonl");
  fs.writeFileSync(seatPath, JSON.stringify({ type: "user", message: { role: "user", content: "Run the project" }, timestamp }) + "\n");
  fs.utimesSync(seatPath, new Date(timestamp), new Date(timestamp));
  replaceConversationCatalog([]);
});

afterEach(() => {
  setAgentRegistryForTests(null);
  registry.close();
  resetTeamStoreForTests();
  replaceConversationCatalog([]);
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousClaude === undefined) delete process.env.LLV_CLAUDE_HOME;
  else process.env.LLV_CLAUDE_HOME = previousClaude;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function designate(pathname: string, id = conversationId) {
  beginOrchestratorSeatIntent({
    project, clientRequestId: "designate-fixture", conversationId: id, mandate: "Run the project", mode: "existing", now: timestamp,
  });
  completeOrchestratorSeatIntent({
    project, clientRequestId: "designate-fixture", conversationId: id, path: pathname, now: timestamp, preparedAuthCredentialBaseline: null,
  });
}

function row(pathname: string, key: string, mtime: number): ConversationCatalogEntry {
  return {
    path: pathname, root: "claude-projects", name: path.basename(pathname), project: key, title: "Run the project",
    firstPrompt: "Catalog-only text", engine: "claude", kind: "session", fmt: "claude", mtime, size: 0,
  };
}

test("the route returns only the aliased seat outside the bounded board window with bounded work", async () => {
  expect(persistProjectAliases([{ source: formerProject, target: project, displayName: "Fixture" }])).toBe(true);
  expect(canonicalProject(formerProject)).toBe(project);
  designate(seatPath);
  const old = row(seatPath, formerProject, Date.parse(timestamp) / 1000);
  const catalog = Array.from({ length: 53_298 }, (_, index) =>
    row(path.join(transcriptRoot, `recent-${index}.jsonl`), project, old.mtime + index + 1)).reverse();
  catalog.push(old);
  let catalogIterations = 0;
  const indexedCatalog = new Proxy(catalog, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) catalogIterations += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  replaceConversationCatalog(indexedCatalog);
  const window = selectSchemeWindow(catalog, (entry) => entry.project === formerProject ? project : entry.project);
  expect(window.some((entry) => entry.path === seatPath)).toBe(false);
  catalogIterations = 0;

  const elapsed: number[] = [];
  const readDir = spyOn(fs.promises, "readdir");
  const readDirSync = spyOn(fs, "readdirSync");
  try {
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      const response = await GET(new Request(`${route}?project=${project}`));
      const body = await response.text();
      elapsed.push(performance.now() - started);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(JSON.parse(body)).toEqual({
        conversationId,
        file: expect.objectContaining({ path: seatPath, conversationId, project: formerProject, mtime: old.mtime }),
      });
      expect(Object.keys(JSON.parse(body) as Record<string, unknown>)).toEqual(["conversationId", "file"]);
      expect(body).not.toContain("Catalog-only text");
      expect(Buffer.byteLength(body)).toBeLessThan(1_024);
    }
    const walked = [...readDir.mock.calls, ...readDirSync.mock.calls].map(([directory]) => String(directory));
    expect(walked.some((directory) => directory.startsWith(path.dirname(transcriptRoot)))).toBe(false);
    expect(catalogIterations).toBe(0);
  } finally {
    readDir.mockRestore();
    readDirSync.mockRestore();
  }
  console.info(`Seat transcript lookup, 53,299 catalog records, first then repeated (ms): ${elapsed.map((time) => time.toFixed(2)).join(", ")}`);
  expect(elapsed).toHaveLength(5);
});

test("an empty catalog reads the materialized generation at its exact path", async () => {
  const receipt = registry.beginSpawn("claude", sandbox, { project, title: "Run the fixture project" });
  registry.completeSpawn(receipt.launchId, {
    key: { engine: "claude", sessionId: "fixture-seat-session" },
    artifactPath: seatPath, cwd: sandbox, accountId: null, status: "idle", host: null,
    claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
  });
  const oldPath = path.join(transcriptRoot, "activation.jsonl");
  fs.copyFileSync(seatPath, oldPath);
  designate(oldPath, receipt.conversationId);
  const response = await GET(new Request(`${route}?project=${project}`));
  expect(await response.json()).toMatchObject({
    conversationId: receipt.conversationId,
    file: { path: seatPath, conversationId: receipt.conversationId, engine: "claude" },
  });
});

test("a stale catalog row or a caller-supplied path cannot substitute for the designated file", async () => {
  const missing = path.join(transcriptRoot, "missing.jsonl");
  designate(missing);
  replaceConversationCatalog([row(seatPath, project, 1), row(missing, project, 0)]);
  const params = new URLSearchParams({ project, path: seatPath, conversationId: "conversation_other" });
  expect(await (await GET(new Request(`${route}?${params}`))).json()).toEqual({ conversationId, file: null });
  expect(await (await GET(new Request(`${route}?project=${foreignProject}`))).json()).toEqual({ conversationId: null, file: null });
});

test("the lookup refuses a designated symlink outside the registered roots", async () => {
  const outside = path.join(sandbox, "outside.jsonl");
  fs.renameSync(seatPath, outside);
  fs.symlinkSync(outside, seatPath);
  designate(seatPath);
  replaceConversationCatalog([row(seatPath, project, 1)]);
  expect(await (await GET(new Request(`${route}?project=${project}`))).json()).toEqual({ conversationId, file: null });
});

test("a retained activation path under an old account link resolves to the discovered path", async () => {
  const shared = path.join(sandbox, "shared", "claude", "projects");
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.renameSync(path.dirname(transcriptRoot), shared);
  fs.symlinkSync(shared, path.dirname(transcriptRoot));
  const discoveredPath = path.join(shared, "fixture", path.basename(seatPath));
  designate(seatPath);
  replaceConversationCatalog([row(discoveredPath, formerProject, 1)]);

  const response = await GET(new Request(`${route}?project=${project}`));
  expect(await response.json()).toMatchObject({
    conversationId,
    file: { path: discoveredPath, conversationId, project: formerProject },
  });
});

test("workspace members can read an aliased seat and need access to its actual transcript", async () => {
  const store = teamStore();
  const person = (id: string, role: Member["role"]): Member => ({
    id, role, name: id, status: "active", color: "teal", telegram: null, createdAt: timestamp, createdBy: "claim", revokedAt: null,
  });
  const owner = person("fixture-owner", "owner");
  const member = person("fixture-member", "member");
  store.insertMember(owner);
  store.insertMember(member);
  const { workspace } = createWorkspace(store, owner, { id: `w_${"a".repeat(32)}`, name: "Fixture", projects: [project] });
  store.putWorkspaceMember(workspace.id, member.id, "member", owner.id, timestamp);
  const cookie = mintSession(store, member.id, "claim", { surface: "desktop", browser: "chrome" }).value;
  const request = (key: string) => new Request(`${route}?project=${key}`, { headers: { cookie: `${MEMBER_COOKIE}=${cookie}` } });

  designate(seatPath);
  expect(persistProjectAliases([{ source: formerProject, target: project, displayName: "Fixture" }])).toBe(true);
  replaceConversationCatalog([row(seatPath, formerProject, 1)]);
  expect((await GET(request(foreignProject))).status).toBe(403);
  const allowed = await GET(request(project));
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toMatchObject({ file: { path: seatPath, project: formerProject, conversationId } });
  replaceConversationCatalog([row(seatPath, foreignProject, 1)]);
  expect((await GET(request(project))).status).toBe(403);
});
