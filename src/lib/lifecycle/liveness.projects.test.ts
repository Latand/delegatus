import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistProjectAliases, projectAliasSnapshot } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";
import { statePath } from "@/lib/configDir";
import type { RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";
import type { FileScanSnapshot } from "@/lib/scanner/scanCache";
import { completedGenerationSelection } from "./inventorySelection";
import { agentLivenessSnapshot, type AgentLivenessSources } from "./liveness";

const NOW = Date.parse("2026-10-26T14:29:00Z");
const PROJECT = "repo-0123456789abcdef0123456789abcdef";
const MOVED = "repo-fedcba9876543210fedcba9876543210";
const OTHER = "repo-abcdefabcdefabcdefabcdefabcdefab";
let directory: string;
let originalAliases: ReturnType<typeof projectAliasSnapshot>;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-projects-"));
  originalAliases = projectAliasSnapshot();
  expect(persistProjectAliases([{ source: MOVED, target: PROJECT, displayName: "Sample project" }])).toBe(true);
});

afterEach(() => {
  projectAliasStore.mutate(statePath("project-aliases.json"), () => ({ next: originalAliases, result: undefined }));
  fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(project = PROJECT, present = true, inventory: "generation" | "legacy" = "generation") {
  const transcript = path.join(directory, "current.jsonl");
  const conversationId = "conversation_project_alias";
  const row = { path: transcript, project, title: "current", engine: "codex", kind: "session", mtime: NOW / 1000,
    size: 4096, activity: "live", conversationId } as FileEntry;
  const files = present ? [row] : [];
  const flows = [{ reviewerMode: "headless" as const, rounds: [{ reviewerPid: 4242, reviewerIdentity: "current-start",
    reviewerPath: transcript, reviewerConversationId: conversationId }] }];
  const sources: AgentLivenessSources = {
    now: () => NOW,
    probe: { now: () => NOW, pidAlive: () => true, processIdentity: () => "current-start" },
    workProcesses: () => [],
    registrySnapshot: () => ({ entries: {}, conversations: {
      [conversationId]: { id: conversationId, generations: [{ path: transcript }], continuityPaths: [] },
    } }) as unknown as RegistryFile,
    pipelines: () => [],
    flows: Object.assign(() => [], { forLiveness: async () => flows, forTarget: async () => flows }),
    describeTranscript: async () => ({ path: transcript, project, title: "current", engine: "codex", mtimeMs: NOW,
      sizeBytes: 4096, conversationId, activity: "live", activityReason: null }),
    transcriptEvidence: async () => ({ turn: "busy", lastRecordTs: NOW }),
    ...(inventory === "legacy" ? { listFiles: async () => files } : {
      selectInventory: (request, options) => completedGenerationSelection(request, {
        signal: options?.signal,
        completedFileScan: async () => ({ snapshot: { files, projectCatalog: [], complete: true } as FileScanSnapshot, generation: 1,
          targetGeneration: 1, cacheStatus: "hit", requestCount: 1, cloneDurationMs: 0 }),
      }),
    }),
  };
  return { sources, conversationId, transcript };
}

test("a short project key lists the live agent returned by a targeted read (#3362)", async () => {
  const { sources, conversationId, transcript } = fixture();
  const request = { project: "repo-01234567", liveOnly: true, limit: 10 };
  const targeted = await agentLivenessSnapshot({ ...request, conversationId }, sources);
  expect(targeted.conversations).toHaveLength(1);
  expect(targeted.conversations[0]).toMatchObject({ transcriptPath: transcript, verified: true, lifecycle: "running" });
  const project = await agentLivenessSnapshot(request, sources);
  expect(project.conversations.map(row => row.transcriptPath)).toEqual([transcript]);
  expect(project.conversations[0]).toMatchObject({ verified: true, lifecycle: "running" });
});

const aliases = [PROJECT, "repo-01234567", "Sample project", MOVED];
const aliasCases = aliases.flatMap(request => aliases.flatMap(entry =>
  (["generation", "legacy"] as const).flatMap(inventory => [true, false].map(present => ({ request, entry, inventory, present })))));

test.each(aliasCases)("project aliases agree: request=$request entry=$entry inventory=$inventory present=$present", async ({ request, entry, inventory, present }) => {
  const { sources, conversationId, transcript } = fixture(entry, present, inventory);
  const targeted = await agentLivenessSnapshot({ project: request, conversationId, liveOnly: true, answerBudgetMs: 10_000 }, sources);
  expect(targeted.conversations).toHaveLength(1);
  const project = await agentLivenessSnapshot({ project: request, liveOnly: true, answerBudgetMs: 10_000 }, sources);
  expect(project.conversations.map(row => row.transcriptPath)).toEqual(targeted.conversations.map(row => row.transcriptPath));
  expect(project.conversations[0]).toMatchObject({ transcriptPath: transcript, verified: true, lifecycle: "running" });
  expect(project.selection.recovered).toBe(present ? 0 : 1);
  expect(project.unresolvedProjectCount ?? 0).toBe(0);
});

test.each([true, false])("an unrelated canonical project stays outside the listing, catalog present=%s", async present => {
  const { sources } = fixture(OTHER, present);
  const project = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true }, sources);
  expect(project.conversations).toEqual([]);
  expect(project.unresolvedProjectCount ?? 0).toBe(0);
});

test.each(["", "unrecorded project"].flatMap(entry => [true, false].map(present => ({ entry, present }))))(
  "an unresolved row is counted once across selection and recovery: entry=$entry present=$present", async ({ entry, present }) => {
    const { sources, conversationId } = fixture(entry, present);
    const targeted = await agentLivenessSnapshot({ project: PROJECT, conversationId, liveOnly: true }, sources);
    expect(targeted.conversations).toHaveLength(1);
    const project = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true, answerBudgetMs: 10_000 }, sources);
    expect(project.conversations).toEqual([]);
    expect(project.unresolvedProjectCount).toBe(1);
  },
);

test("an ambiguous requested name refuses and an ambiguous row is counted as unresolved", async () => {
  expect(persistProjectAliases([{ source: "other-repository", target: OTHER, displayName: "Sample project" }])).toBe(true);
  const { sources } = fixture("Sample project");
  await expect(agentLivenessSnapshot({ project: "Sample project", liveOnly: true }, sources)).rejects.toMatchObject({
    details: { code: "ambiguous_project" },
  });
  const project = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true }, sources);
  expect(project.conversations).toEqual([]);
  expect(project.unresolvedProjectCount).toBe(1);
});
