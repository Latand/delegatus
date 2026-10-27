import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { persistProjectAliases, projectAliasSnapshot } from "@/lib/projects/aliases";
import { projectAliasStore } from "@/lib/projects/persistence";
import { statePath } from "@/lib/configDir";
import type { RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";
import type { FileScanSnapshot } from "@/lib/scanner/scanCache";
import { conversationCatalogSnapshot, replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { compactLiveness } from "@/lib/mcp/compactAnswers";
import { completedGenerationSelection } from "./inventorySelection";
import { agentLivenessSnapshot, HOSTED_RECOVERY_MAX, type AgentLivenessSources } from "./liveness";

const NOW = Date.parse("2026-10-26T14:29:00Z");
const PROJECT = "repo-0123456789abcdef0123456789abcdef";
const MOVED = "repo-fedcba9876543210fedcba9876543210";
const OTHER = "repo-abcdefabcdefabcdefabcdefabcdefab";
let directory: string;
let originalAliases: ReturnType<typeof projectAliasSnapshot>;
let originalCatalog: ReturnType<typeof conversationCatalogSnapshot>;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-projects-"));
  originalAliases = projectAliasSnapshot();
  originalCatalog = conversationCatalogSnapshot();
});

afterEach(() => {
  projectAliasStore.mutate(statePath("project-aliases.json"), () => ({ next: originalAliases, result: undefined }));
  replaceConversationCatalog([...originalCatalog]);
  fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(project = PROJECT, present = true, inventory: "generation" | "legacy" = "generation", options: { seed?: boolean; projectName?: string; projectCatalog?: FileScanSnapshot["projectCatalog"] } = {}) {
  if (options.seed !== false) expect(persistProjectAliases([{ source: MOVED, target: PROJECT, displayName: "Sample project" }])).toBe(true);
  const transcript = path.join(directory, "current.jsonl");
  const conversationId = "conversation_project_alias";
  const row = { path: transcript, project, title: "current", engine: "codex", kind: "session", mtime: NOW / 1000,
    size: 4096, activity: "live", conversationId, projectName: options.projectName } as FileEntry;
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
      selectInventory: (request, selectionOptions) => completedGenerationSelection(request, {
        signal: selectionOptions?.signal,
        completedFileScan: async () => ({ snapshot: { files, projectCatalog: options.projectCatalog ?? [], complete: true } as FileScanSnapshot, generation: 1,
          targetGeneration: 1, cacheStatus: "hit", requestCount: 1, cloneDurationMs: 0 }),
      }),
    }),
  };
  return { sources, conversationId, transcript, files, row };
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

test.each(["generation", "legacy"] as const)("file-only display names resolve without registered aliases: %s", async inventory => {
  const { sources, files, row, conversationId } = fixture(PROJECT, true, inventory, { seed: false, projectName: "File-only project" });
  files.unshift({ ...row, path: path.join(directory, "unrelated.jsonl"), project: OTHER, projectName: "Other project", conversationId: "conversation_other" });
  const request = { project: "File-only project", liveOnly: true, limit: 1 };
  const targeted = await agentLivenessSnapshot({ ...request, conversationId }, sources);
  const project = await agentLivenessSnapshot(request, sources);
  expect(targeted.count).toBe(1);
  expect(project.conversations.map(row => row.transcriptPath)).toEqual(targeted.conversations.map(row => row.transcriptPath));
  expect(project.unresolvedProjectCount ?? 0).toBe(0);
});

test("a name retained only in the project catalog resolves before filtering", async () => {
  const { sources, transcript } = fixture(PROJECT, true, "generation", { seed: false,
    projectCatalog: [{ project: PROJECT, displayName: "Catalog-only project" }] as FileScanSnapshot["projectCatalog"] });
  const project = await agentLivenessSnapshot({ project: "Catalog-only project", liveOnly: true }, sources);
  expect(project.conversations.map(row => row.transcriptPath)).toEqual([transcript]);
});

test.each(["generation", "legacy"] as const)("uncatalogued hosts supply canonical identities before short scope resolution: %s", async inventory => {
  const { sources, conversationId } = fixture(PROJECT, false, inventory, { seed: false });
  const request = { project: "repo-01234567", liveOnly: true, answerBudgetMs: 800 };
  const targeted = await agentLivenessSnapshot({ ...request, conversationId }, sources);
  const project = await agentLivenessSnapshot(request, sources);
  expect(targeted.count).toBe(1);
  expect(project.conversations.map(row => row.transcriptPath)).toEqual(targeted.conversations.map(row => row.transcriptPath));
  expect(project.selection.recovered).toBe(1);
  expect(project.unresolvedProjectCount ?? 0).toBe(0);
});

test.each([true, false])("MCP activity resolves an unseeded short key through the real binding, catalog present=%s", async present => {
  const { sources, conversationId } = fixture(PROJECT, present, "generation", { seed: false });
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const bindings = viewerMcpBindings(undefined, undefined, {
    livenessSources: () => sources, refreshLifecycleJournal: () => ({ appended: 0 }),
  } as never);
  const service = createMcpToolService(bindings, new MemoryMcpReceiptStore());
  const targeted = await service.callTool("agent_activity", { clientRequestId: "activity-target", conversationId, liveOnly: true, full: true });
  const scoped = await service.callTool("agent_activity", { clientRequestId: "activity-scope", project: "repo-01234567", liveOnly: true, full: true });
  expect(targeted).toMatchObject({ ok: true, count: 1 });
  if (!targeted.ok) throw new Error(targeted.error);
  expect(scoped).toMatchObject({ ok: true, count: 1, conversations: targeted.conversations });
});

test("MCP activity preserves short-key ambiguity from retained file metadata", async () => {
  const { sources, files, row } = fixture(PROJECT, true, "generation", { seed: false });
  files.push({ ...row, path: path.join(directory, "collision.jsonl"), project: PROJECT.slice(0, 13) + "f".repeat(24) });
  const { viewerMcpBindings } = await import("@/lib/mcp/bindings");
  const { createMcpToolService, MemoryMcpReceiptStore } = await import("@/lib/mcp/server");
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, {
    livenessSources: () => sources, refreshLifecycleJournal: () => ({ appended: 0 }),
  } as never), new MemoryMcpReceiptStore());
  expect(await service.callTool("agent_activity", { clientRequestId: "activity-ambiguous", project: "repo-01234567", liveOnly: true })).toMatchObject({
    ok: false, code: "ambiguous_project", retryable: false,
  });
  files.pop();
  expect(await service.callTool("agent_activity", { clientRequestId: "activity-ambiguous", project: "repo-01234567", liveOnly: true })).toMatchObject({
    ok: true, count: 1, replayed: false,
  });
});

test.each(["project_unresolved", "unrecorded project", OTHER])("a verified host description supersedes stale catalog project %s", async project => {
  const { sources, conversationId } = fixture(project, true, "generation", { seed: false });
  const describe = sources.describeTranscript;
  sources.describeTranscript = async candidate => {
    const entry = await describe(candidate);
    return entry ? { ...entry, project: PROJECT } : entry;
  };
  const request = { project: "repo-01234567", liveOnly: true, answerBudgetMs: 800 };
  const targeted = await agentLivenessSnapshot({ ...request, conversationId }, sources);
  const snapshot = await agentLivenessSnapshot(request, sources);
  expect(targeted.count).toBe(1);
  expect(snapshot.conversations.map(row => row.transcriptPath)).toEqual(targeted.conversations.map(row => row.transcriptPath));
  expect(snapshot.unresolvedProjectCount ?? 0).toBe(0);
});

test("unseeded file names preserve ambiguity refusal", async () => {
  const { sources, files, row } = fixture(PROJECT, true, "generation", { seed: false, projectName: "Shared project" });
  files.push({ ...row, project: OTHER, path: path.join(directory, "other.jsonl"), projectName: "Shared project" });
  await expect(agentLivenessSnapshot({ project: "Shared project", liveOnly: true }, sources)).rejects.toMatchObject({
    details: { code: "ambiguous_project" },
  });
});

test.each([false, true])("scope resolution includes hosts beyond the prefetch limit, colliding=%s", async colliding => {
  const { sources, transcript } = fixture(PROJECT, false, "generation", { seed: false });
  const otherPath = path.join(directory, "other-host.jsonl");
  const otherProject = colliding ? PROJECT.slice(0, 13) + "f".repeat(24) : OTHER;
  const originalDescribe = sources.describeTranscript;
  sources.describeTranscript = async candidate => {
    const entry = await originalDescribe(candidate);
    return candidate === otherPath && entry ? { ...entry, path: otherPath, project: otherProject, conversationId: null } : entry;
  };
  sources.flows = Object.assign(() => [], { forLiveness: async () => [{ reviewerMode: "headless" as const,
    rounds: [otherPath, transcript].map(reviewerPath => ({ reviewerPath, reviewerPid: 4242, reviewerIdentity: "current-start" })) }] });
  const read = agentLivenessSnapshot({ project: "repo-01234567", liveOnly: true, limit: 1, answerBudgetMs: 800 }, sources);
  if (colliding) await expect(read).rejects.toMatchObject({ details: { code: "ambiguous_project" } });
  else expect((await read).conversations.map(row => row.transcriptPath)).toEqual([transcript]);
});

function cataloguedHosts(currentProject = PROJECT, inventory: "generation" | "legacy" = "generation") {
  const fixtureData = fixture(currentProject === PROJECT ? OTHER : PROJECT, true, inventory);
  const { sources, transcript, files, row } = fixtureData;
  const otherPath = path.join(directory, "first-host.jsonl");
  files.unshift({ ...row, path: otherPath, project: OTHER, conversationId: "conversation_first_host" });
  const describe = sources.describeTranscript;
  sources.describeTranscript = async candidate => {
    const entry = await describe(candidate);
    return entry ? { ...entry, path: candidate, project: candidate === transcript ? currentProject : OTHER,
      conversationId: candidate === transcript ? fixtureData.conversationId : "conversation_first_host" } : entry;
  };
  sources.flows = Object.assign(sources.flows!, { forLiveness: async () => [{ reviewerMode: "headless" as const,
    rounds: [otherPath, transcript].map(reviewerPath => ({ reviewerPath, reviewerPid: 4242, reviewerIdentity: "current-start" })) }] });
  return fixtureData;
}

test.each((["generation", "legacy"] as const).flatMap(inventory => [PROJECT, OTHER].map(currentProject => ({ inventory, currentProject }))))(
  "catalogued hosts beyond the prefetch limit use current membership: $inventory $currentProject", async ({ inventory, currentProject }) => {
    const { sources, conversationId, transcript } = cataloguedHosts(currentProject, inventory);
    const request = { project: "repo-01234567", liveOnly: true, limit: 1, answerBudgetMs: 800 };
    const targeted = await agentLivenessSnapshot({ ...request, conversationId }, sources);
    expect(targeted.conversations).toHaveLength(1);
    expect(targeted.conversations[0]).toMatchObject({ transcriptPath: transcript, project: currentProject, verified: true });
    const snapshot = await agentLivenessSnapshot(request, sources);
    expect(snapshot.conversations).toEqual(currentProject === PROJECT ? targeted.conversations : []);
    expect(snapshot.unresolvedProjectCount ?? 0).toBe(0);
    expect(snapshot.selection.recovered).toBe(0);
  },
);

test.each(["pending", "missing", "refused"] as const)("unresolved current host membership never falls back to a stale catalog: %s", async outcome => {
  const { sources, transcript } = cataloguedHosts(OTHER);
  const describe = sources.describeTranscript;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  sources.describeTranscript = async candidate => {
    if (candidate !== transcript) return describe(candidate);
    if (outcome === "pending") await held;
    if (outcome === "refused") throw new Error("description unavailable");
    return null;
  };
  try {
    const snapshot = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true, limit: 1, answerBudgetMs: 100 }, sources);
    expect(snapshot.conversations).toEqual([]);
    expect(snapshot.unresolvedProjectCount).toBe(1);
    expect(snapshot.selection.recoveryPending).toBe(outcome === "pending" ? 1 : 0);
  } finally { release(); }
});

test("describing catalogued owners beyond the row limit does not count them as recovered", async () => {
  const { sources, files } = cataloguedHosts();
  const describe = sources.describeTranscript;
  files[0]!.project = PROJECT;
  sources.describeTranscript = async candidate => {
    const entry = await describe(candidate);
    return entry ? { ...entry, project: PROJECT } : entry;
  };
  const snapshot = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true, limit: 1, answerBudgetMs: 800 }, sources);
  expect(snapshot.conversations.map(row => row.transcriptPath)).toEqual([files[0]!.path]);
  expect(snapshot.selection).toMatchObject({ matched: 2, selected: 1, recovered: 0 });
});

test("catalogued host identity resolution stays capped and reports hosts outside the cap", async () => {
  const { sources, files, row } = fixture(PROJECT);
  const paths = Array.from({ length: HOSTED_RECOVERY_MAX + 3 }, (_, i) => path.join(directory, `capped-host-${i}.jsonl`));
  files.splice(0, files.length, ...paths.map(candidate => ({ ...row, path: candidate, conversationId: undefined })));
  sources.flows = Object.assign(() => [], { forLiveness: async () => [{ reviewerMode: "headless" as const,
    rounds: paths.map(reviewerPath => ({ reviewerPath, reviewerPid: 4242, reviewerIdentity: "current-start" })) }] });
  const described: string[] = [];
  const describe = sources.describeTranscript;
  sources.describeTranscript = async candidate => {
    described.push(candidate);
    const entry = await describe(candidate);
    return entry ? { ...entry, path: candidate, project: OTHER, conversationId: null } : entry;
  };
  const snapshot = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true, limit: 1, answerBudgetMs: 800 }, sources);
  expect(snapshot.count).toBe(0);
  expect(described).toEqual([paths[0], ...paths.slice(-HOSTED_RECOVERY_MAX)]);
  expect(snapshot.unresolvedProjectCount).toBe(2);
  expect(snapshot.selection.recoveryTruncated).toBe(true);
});

test.each([true, false])("the scanner sentinel counts once with published catalog present=%s", async present => {
  const { sources, row } = fixture("project_unresolved", present, "generation", { seed: false });
  if (present) replaceConversationCatalog([row as unknown as Parameters<typeof replaceConversationCatalog>[0][number]]);
  const snapshot = await agentLivenessSnapshot({ project: OTHER, liveOnly: true, answerBudgetMs: 800 }, sources);
  expect(snapshot.count).toBe(0);
  expect(snapshot.unresolvedProjectCount).toBe(1);
  expect(compactLiveness(snapshot)).toMatchObject({ count: 0, unresolvedProjectCount: 1 });
});

test("a registered legacy project remains a resolved identity", async () => {
  const { sources, row } = fixture("legacy-project", true, "generation", { seed: false });
  replaceConversationCatalog([row as unknown as Parameters<typeof replaceConversationCatalog>[0][number]]);
  const own = await agentLivenessSnapshot({ project: "legacy-project", liveOnly: true }, sources);
  expect(own.count).toBe(1);
  const other = await agentLivenessSnapshot({ project: OTHER, liveOnly: true }, sources);
  expect(other.count).toBe(0);
  expect(other.unresolvedProjectCount ?? 0).toBe(0);
});

test("a display name resolving to the scanner sentinel remains unresolved", async () => {
  const { sources } = fixture("Sentinel label");
  expect(persistProjectAliases([{ source: "sentinel-old", target: "project_unresolved", displayName: "Sentinel label" }])).toBe(true);
  const snapshot = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true }, sources);
  expect(snapshot.count).toBe(0);
  expect(snapshot.unresolvedProjectCount).toBe(1);
});

test("a spent answer counts deferred label resolution and the next answer resolves it", async () => {
  const { sources, transcript } = fixture("Sample project");
  const expired = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true, answerBudgetMs: 0 }, sources);
  expect(expired.count).toBe(0);
  expect(expired.unresolvedProjectCount).toBe(1);
  const next = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true, answerBudgetMs: 800 }, sources);
  expect(next.conversations.map(row => row.transcriptPath)).toEqual([transcript]);
  expect(next.unresolvedProjectCount ?? 0).toBe(0);
});

test.each([3, 12])("recovered project hosts share evidence concurrency and byte limits, tails=%s", async tails => {
  const { sources } = fixture(PROJECT, false);
  const paths = Array.from({ length: 12 }, (_, i) => path.join(directory, "host-" + i + ".jsonl"));
  const describe = sources.describeTranscript;
  sources.describeTranscript = async candidate => {
    const entry = await describe(candidate);
    return entry ? { ...entry, path: candidate, sizeBytes: 128 * 1024, conversationId: null } : entry;
  };
  sources.flows = Object.assign(() => [], { forLiveness: async () => [{ reviewerMode: "headless" as const,
    rounds: paths.map(reviewerPath => ({ reviewerPath, reviewerPid: 4242, reviewerIdentity: "current-start" })) }] });
  sources.transcriptIdentity = async () => null;
  let active = 0;
  let peak = 0;
  let reads = 0;
  sources.transcriptEvidence = async () => {
    reads++; active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return { turn: "busy", lastRecordTs: NOW };
  };
  const snapshot = await agentLivenessSnapshot({ project: PROJECT, liveOnly: true, limit: 12,
    answerBudgetMs: 800, evidenceConcurrency: 2, evidenceByteBudget: tails * 128 * 1024 }, sources);
  expect(snapshot.count).toBe(12);
  expect(peak).toBe(2);
  expect(reads).toBe(tails);
  expect(active).toBe(0);
});

test.each([false, true])("fresh processes bound 300 unknown labels over 1,000 project keys, cancel=%s", async cancel => {
  // The parent excludes startup and measures even if selection blocks the
  // child's deadline timer and its cancellation handler.
  const source = [
    'import { agentLivenessSnapshot } from "./src/lib/lifecycle/liveness";',
    'import { replaceProjectKeySource } from "./src/lib/projects/projectKeyIndex";',
    "const project = " + JSON.stringify(PROJECT) + ";",
    "const now = " + NOW + ";",
    'replaceProjectKeySource("budget-fixture", Array.from({ length: 1000 }, (_, i) => "repo-" + i.toString(16).padStart(32, "0")));',
    'const files = Array.from({ length: 300 }, (_, i) => ({ path: "/fixture/unknown-" + i + ".jsonl", project: "unknown-project-" + i, engine: "codex", title: "active", kind: "session", mtime: now / 1000, size: 100, activity: "live" }));',
    'files.push({ ...files[0], path: "/fixture/known.jsonl", project });',
    'const controller = new AbortController();',
    'const sources = { now: () => now, registrySnapshot: () => ({ entries: {}, conversations: {} }), pipelines: () => [], flows: () => [], listFiles: async () => files, describeTranscript: async () => null, transcriptIdentity: async () => null,',
    'transcriptEvidence: async () => ' + (cancel ? 'new Promise(() => {})' : '({ turn: "busy", lastRecordTs: now })') + ',',
    'probe: { now: () => now, pidAlive: () => false, processIdentity: () => null }, workProcesses: () => [] };',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", data => {',
    'if (data.includes("cancel")) controller.abort();',
    'if (!data.includes("start")) return;',
    'console.log("started");',
    'agentLivenessSnapshot({ project, liveOnly: true, limit: 10, answerBudgetMs: 800, signal: controller.signal }, sources)',
    '.then(snapshot => { console.log(JSON.stringify({ outcome: "answered", unresolved: snapshot.unresolvedProjectCount, selectionMs: snapshot.timings.inventorySelectionMs })); process.exit(0); },',
    'error => { console.log(JSON.stringify({ outcome: error.name })); process.exit(0); });',
    '}); console.log("ready");',
  ].join("\n");
  const results: { outcome: string; unresolved?: number; elapsedMs: number }[] = [];
  for (let run = 0; run < 2; run++) {
    const child = spawn(process.execPath, ["-e", source], { cwd: process.cwd(), env: { ...process.env,
      LLV_STATE_DIR: path.join(directory, ["process", cancel, run].join("-")) }, stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const iterator = lines[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toBe("ready");
      const startedAt = performance.now();
      child.stdin.write("start\n");
      expect((await iterator.next()).value).toBe("started");
      if (cancel) cancelTimer = setTimeout(() => child.stdin.write("cancel\n"), 50);
      const message = (await iterator.next()).value;
      const elapsedMs = performance.now() - startedAt;
      expect(await exit, stderr).toBe(0);
      expect(message).toBeDefined();
      const result = JSON.parse(message!);
      console.log(JSON.stringify({ cancel, run, elapsedMs, ...result }));
      results.push({ ...result, elapsedMs });
    } finally {
      clearTimeout(deadline);
      clearTimeout(cancelTimer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      lines.close();
    }
  }
  for (const result of results) {
    expect(result.outcome).toBe(cancel ? "AbortError" : "answered");
    if (!cancel) expect(result.unresolved).toBe(300);
    expect(result.elapsedMs).toBeLessThan(1200); // 800 ms answer + 400 ms parent/IPC overhead.
  }
}, 30_000);
