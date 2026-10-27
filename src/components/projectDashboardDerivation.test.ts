import { expect, test } from "bun:test";
import type { FileEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import { directReviewFlows } from "./flows/directReviewGroups";
import { foldClaimedReviewers } from "./flows/flowModel";
import { launchHistoryFor, LAUNCH_HISTORY_HORIZON_MS } from "./launchHistoryModel";
import { buildBranchGroups, descendantsOf, kidsIndex, projectDescendantsOf } from "./projectModel";
import { createProjectBands, createProjectDashboardDerivation } from "./projectDashboardDerivation";
import { buildSchemeLayout } from "./scheme/layout";
import { boundFlowExpansions } from "./scheme/placementHorizon";
import { transcriptClaimResolver } from "./transcriptClaims";
import { buildTaskBands } from "./scheme/taskBands";
import { createTaskWorkflowProjector } from "./tasks/taskWorkflowModel";
import { partitionTaskStacks, TASK_STACK_RECENT_MS } from "./scheme/taskStacks";

const NOW = 1_790_000_000;
function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return { path, name: path, project: "atlas", root: "claude-projects", engine: "claude", kind: "session", fmt: "claude",
    parent: null, title: path, mtime: NOW, size: 10, activity: "idle", proc: null, pid: null, model: null,
    pendingQuestion: null, waitingInput: null, ...over };
}

test("relationship-only consumers retain paths across metadata refreshes and retire on every other edit", () => {
  const derive = createProjectDashboardDerivation();
  const root = file("/repo/root", { conversationId: "root" });
  const first = [root];
  expect(derive.relationshipFiles(first)).toBe(first);
  expect(derive.relationshipFiles([{ ...root, size: 20, mtime: NOW + 100 }])).toBe(first);
  for (const files of [[{ ...root, path: "/repo/new" }], [{ ...root, generation: 2 }],
    [{ ...root, parent: "/repo/parent" }], [{ ...root, activity: "live" as const }],
    [root, file("/repo/other")], [file("/repo/other"), root], [], first]) {
    expect(derive.relationshipFiles(files)).toBe(files);
  }
});

test("a catalog metadata answer does not rebuild the dashboard relationship model (#2218)", () => {
  const derive = createProjectDashboardDerivation();
  const root = file("/repo/root.jsonl", { conversationId: "root", activity: "live" });
  const child = file("/repo/child.jsonl", { conversationId: "child", parent: root.path, activity: "live" });
  const firstCatalog = [root, child];
  const relationshipCatalog = derive.relationshipFiles(firstCatalog);
  const groups = derive.baseGroups(relationshipCatalog, "atlas", { now: NOW });

  // Polling creates fresh row objects even when only transcript byte counts and
  // mtimes advanced. Those payload fields must not invalidate the topology that
  // feeds descendant, flow-membership, and branch-group derivations.
  const polledCatalog = firstCatalog.map((row, index) => ({ ...row, size: row.size + index + 1, mtime: row.mtime + 1 }));
  const nextRelationshipCatalog = derive.relationshipFiles(polledCatalog);
  const nextGroups = derive.baseGroups(nextRelationshipCatalog, "atlas", { now: NOW });

  expect(nextRelationshipCatalog).toBe(relationshipCatalog);
  expect(nextGroups).toBe(groups);
  expect(nextGroups.map(group => group.columns.flatMap(column => column.file.path)))
    .toEqual([[root.path, child.path]]);
});

test("equal task stacks retain identity while recency, due dates and explicit expansion remain live", () => {
  const derive = createProjectDashboardDerivation();
  const tasks: BoardTask[] = [{ id: "stack", project: "atlas", text: "Stacked work", status: "done", placement: "pinned", pos: { x: 0, y: 0 },
    assignments: [], createdAt: new Date(NOW * 1000).toISOString(), updatedAt: new Date(NOW * 1000).toISOString() }];
  const context = { files: [] as FileEntry[], nowMs: NOW * 1000, expandedIds: new Set<string>(), focusedTaskId: null };
  const first = derive.taskPartition(tasks, context);
  expect(derive.taskPartition(tasks, { ...context, nowMs: context.nowMs + 1 })).toBe(first);
  for (const delta of [TASK_STACK_RECENT_MS - 1, TASK_STACK_RECENT_MS, TASK_STACK_RECENT_MS + 1, 0]) {
    for (const expandedIds of [new Set<string>(), new Set(["stack"])]) {
      const input = { ...context, nowMs: context.nowMs + delta, expandedIds };
      expect(derive.taskPartition(tasks, input)).toEqual(partitionTaskStacks(tasks, input));
      const due = [{ ...tasks[0], dueAt: new Date(input.nowMs - 1).toISOString() }];
      expect(derive.taskPartition(due, input)).toEqual(partitionTaskStacks(due, input));
    }
  }
});

test("reviewer folding retains its ownership plan and refreshes visible and rewritten child payloads", () => {
  const derive = createProjectDashboardDerivation();
  const root = file("/repo/root.jsonl"), reviewer = file("/repo/reviewer.jsonl");
  const child = file("/repo/child.jsonl", { parent: reviewer.path });
  const flows = [{ id: "review", implementerPath: root.path, rounds: [{ n: 1, reviewerPath: reviewer.path }] }] as unknown as Flow[];
  const protectedPaths = new Set<string>();
  const first = derive.groupFiles([root, reviewer, child], flows, protectedPaths);
  expect(first.map(row => row.path)).toEqual([root.path, child.path]);
  expect(first[1].parent).toBe(root.path);
  expect(derive.groupFiles([root, { ...reviewer, size: 20 }, child], flows, protectedPaths)).toBe(first);
  for (const files of [[{ ...root, size: 20 }, reviewer, child], [root, reviewer, { ...child, mtime: NOW + 1 }],
    [root, { ...reviewer, path: "/repo/replacement.jsonl" }, child], [child, reviewer, root],
    [root, child], [root, reviewer, child, { ...child, title: "Duplicate path" }], [], [root, reviewer, child]]) {
    for (const protectedSet of [protectedPaths, new Set([reviewer.path])]) {
      expect(derive.groupFiles(files, flows, protectedSet)).toEqual(foldClaimedReviewers(files, flows, protectedSet));
    }
  }
  const changedFlows = [{ ...flows[0], implementerPath: "/repo/another.jsonl" }];
  expect(derive.groupFiles([root, reviewer, child], changedFlows, protectedPaths))
    .toEqual(foldClaimedReviewers([root, reviewer, child], changedFlows, protectedPaths));
});

test("scene filtering retains equal visible files and admits refreshed payloads when unfolded", () => {
  const derive = createProjectDashboardDerivation();
  const visible = file("/repo/visible"), hidden = file("/repo/hidden");
  const collapsed = new Set([hidden.path]), empty = new Set<string>();
  const first = derive.sceneFiles([visible, hidden], collapsed, empty, empty);
  const fresh = { ...hidden, size: 100, mtime: NOW + 100 };
  expect(derive.sceneFiles([visible, fresh], collapsed, empty, empty)).toBe(first);
  expect(derive.sceneFiles([visible, fresh], empty, empty, empty)).toEqual([visible, fresh]);
  expect(derive.sceneFiles([visible, fresh], empty, empty, new Set([hidden.path]))).toEqual([visible]);
});

test("clock-only equal memberships and layouts retain identity; deadline expiry matches full derivation", () => {
  const derive = createProjectDashboardDerivation();
  const files = [file("/repo/root.jsonl")];
  let last: ReturnType<typeof buildBranchGroups> | undefined;
  let layout: ReturnType<typeof buildSchemeLayout> | undefined;
  for (const now of [NOW, NOW + 30, NOW + 60]) {
    const options = { now, ageHorizonSeconds: 100 };
    const groups = derive.baseGroups(files, "atlas", options);
    expect(groups).toEqual(buildBranchGroups(files, "atlas", options));
    if (last) expect(groups).toBe(last);
    const next = derive.layout(groups, [], files, [], [], [], [], new Set(), new Set(), [], new Set(), { now });
    expect(next).toEqual(buildSchemeLayout(groups, [], files, [], [], [], [], new Set(), new Set(), [], new Set(), { now }));
    if (layout) expect(next).toBe(layout);
    last = groups; layout = next;
  }
  for (const now of [NOW + 99, NOW + 100, NOW + 101, NOW + 10000, 0, NOW]) {
    const options = { now, ageHorizonSeconds: 100 };
    expect(derive.baseGroups(files, "atlas", options)).toEqual(buildBranchGroups(files, "atlas", options));
  }
  expect(derive.baseGroups(files, "atlas", { now: NOW + 101, ageHorizonSeconds: 100 })).toHaveLength(0);
});

test("file payloads, generation, topology, ordering, removal and project replacement reach the full oracle", () => {
  const derive = createProjectDashboardDerivation();
  const root = file("/repo/root.jsonl", { activity: "live", conversationId: "root" });
  const child = file("/repo/child.jsonl", { parent: root.path, activity: "live", conversationId: "child" });
  const corpora = [
    [root, child], [root, { ...child, size: 20 }], [root, { ...child, mtime: NOW + 1 }],
    [root, { ...child, title: "Renamed" }], [root, { ...child, activity: "idle" as const }],
    [root, { ...child, path: "/repo/new-generation.jsonl" }], [root, { ...child, parent: null }],
    [child, root], [root], [], [file("/repo/other.jsonl", { project: "other", activity: "live" })], [root, child],
  ];
  let previous: ReturnType<typeof buildSchemeLayout> | undefined;
  for (const files of corpora) {
    const project = files[0]?.project ?? "atlas";
    const groups = derive.baseGroups(files, project, { now: NOW });
    expect(groups).toEqual(buildBranchGroups(files, project, { now: NOW }));
    const layout = derive.layout(groups, [], files);
    expect(layout).toEqual(buildSchemeLayout(groups, [], files));
    if (previous && files.length) expect(layout).not.toBe(previous);
    previous = layout;
  }
  expect(createProjectDashboardDerivation().baseGroups([root], "atlas")).not.toBe(derive.baseGroups([root], "atlas"));
});

test("group clock cache checks hydration, cross-project roots and every placement option", () => {
  const derive = createProjectDashboardDerivation();
  const root = file("/repo/foreign", { project: "foreign" });
  const files = [root, file("/repo/segment", { parent: root.path }),
    file("/repo/recent", { activity: "recent" }), file("/repo/live", { activity: "live" }),
    file("/repo/running", { proc: "running" }), file("/repo/child", { parent: "/repo/segment" })];
  for (const now of [-1, 0, NOW, NOW + 99, NOW + 100, NOW + 101, NOW + 1000, 0, NOW]) {
    for (const options of [{}, { keepExpandedPaths: new Set(["/repo/segment"]) },
      { expandedConversationPaths: new Set(["/repo/child"]) }, { ageHorizonSeconds: 2000 }]) {
      const input = { ageHorizonSeconds: 100, ...options, now };
      expect(derive.baseGroups(files, "atlas", input)).toEqual(buildBranchGroups(files, "atlas", input));
      expect(derive.groups(files, "atlas", input)).toEqual(buildBranchGroups(files, "atlas", input));
    }
  }
});

test("launch history enters at its millisecond deadline and disappears on removal", () => {
  const derive = createProjectDashboardDerivation();
  const receipt = file("spawn:receipt", { spawn: { launchId: "receipt", clientAttemptId: null, accountId: "default", state: "failed", initialMessage: "failed", retrySafe: true, error: "failed" } });
  const boundary = NOW * 1000 + LAUNCH_HISTORY_HORIZON_MS;
  for (const now of [0, boundary - 1, boundary, boundary + 1, boundary + 100000]) {
    expect(derive.launchHistory([receipt], "atlas", now)).toEqual(launchHistoryFor([receipt], "atlas", now));
  }
  const held = derive.launchHistory([receipt], "atlas", boundary);
  expect(held).toHaveLength(1);
  expect(derive.launchHistory([receipt], "atlas", boundary + 1)).toBe(held);
  expect(derive.launchHistory([], "atlas", boundary + 1)).toEqual([]);
});

test("layout reuses hidden metadata while represented payloads and competing generations stay fresh", () => {
  const root = file("/repo/root.jsonl", { conversationId: "root", activity: "live" });
  const child = file("/repo/child.jsonl", { conversationId: "child", parent: root.path });
  const hidden = file("/repo/hidden.jsonl", { conversationId: "hidden", mtime: NOW - 10000 });
  const derive = createProjectDashboardDerivation();
  const first = derive.layout([], [root], [root, child, hidden]);
  const updated = [root, child, { ...hidden, size: 100, mtime: NOW }];
  expect(derive.layout([], [root], updated)).toBe(first);
  expect(first).toEqual(buildSchemeLayout([], [root], updated));
  // Duplicate identities use freshness to choose lineage and review targets.
  const other = file("/repo/other-generation.jsonl", { conversationId: "hidden", mtime: NOW - 20000 });
  const descendant = file("/repo/descendant.jsonl", { conversationId: "descendant", durableLineage: {
    kind: "spawn", role: "worker", parentConversationId: "hidden", reviewsConversationId: null, memberships: [],
  } });
  const corpora = [[root, child, hidden], [root, child, hidden, other, descendant]];
  for (const files of corpora) {
    for (const manual of [[root], [descendant], files]) {
      for (let i = 0; i < files.length; i++) {
        const next = files.map((row, index) => index === i ? { ...row, size: row.size + 1, mtime: NOW + 100 } : row);
        for (const rows of [files, next, files]) {
          expect(derive.layout([], manual, rows)).toEqual(buildSchemeLayout([], manual, rows));
        }
      }
    }
  }
});

test("band projection retains equal memberships and refreshes payloads, labels, drafts and task edits", () => {
  const derive = createProjectBands(), project = createTaskWorkflowProjector();
  const visible = file("/repo/visible.jsonl"), hidden = file("/repo/hidden.jsonl");
  const tasks: BoardTask[] = [{ id: "empty", project: "atlas", text: "", status: "inbox", placement: "unplaced", assignments: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" }];
  const pipelines: Pipeline[] = [], flows: Flow[] = [];
  const layout = buildSchemeLayout([], [visible], [visible, hidden]);
  const sources = { tasks, projection: project(tasks, pipelines, flows, [visible, hidden]), untitled: "Untitled", deferDoneVisibility: true };
  const first = derive(layout, sources);
  const fresh = { ...sources, projection: project(tasks, pipelines, flows, [visible, { ...hidden, size: 99, mtime: NOW + 1 }]) };
  expect(derive(layout, fresh)).toBe(first);
  expect(derive(layout, fresh)).toEqual(buildTaskBands(layout, fresh));
  const changedTasks = [{ ...tasks[0], text: "Named task", status: "blocked" as const }];
  for (const [base, input] of [
    [layout, { ...fresh, untitled: "Без назви" }],
    [buildSchemeLayout([], [{ ...visible, title: "Updated conversation" }], [visible, hidden]), fresh],
    [buildSchemeLayout([], [visible], [visible, hidden], [], ["draft"]), fresh],
    [layout, { ...fresh, tasks: changedTasks, projection: project(changedTasks, pipelines, flows, [visible, hidden]) }],
  ] as const) expect(derive(base, input)).toEqual(buildTaskBands(base, input));
});

test("direct-review failure deadline, protection, acknowledgement and generation changes match full derivation", () => {
  const derive = createProjectDashboardDerivation();
  const anchor = file("/repo/anchor.jsonl", { conversationId: "anchor" });
  const reviewer = file("/repo/reviewer.jsonl", { conversationId: "reviewer", durableLineage: {
    kind: "review", role: "reviewer", parentConversationId: "seat", reviewsConversationId: "anchor", memberships: [],
  } });
  const input = { files: [anchor, reviewer], flows: [], nowMs: NOW * 1000, idleMs: 1000 };
  const first = derive.directReviews(input);
  expect(first).toHaveLength(1);
  expect(derive.directReviews({ ...input, nowMs: input.nowMs + 999 })).toBe(first);
  for (const change of [
    { nowMs: input.nowMs + 1000 }, { nowMs: input.nowMs + 1001 },
    { nowMs: input.nowMs + 1001, protectedPaths: new Set([reviewer.path]) },
    { seenAt: new Map([["reviewer", input.nowMs + 1001]]) },
    { files: [{ ...anchor, path: "/repo/anchor-next.jsonl" }, reviewer] }, { files: [anchor] },
  ]) expect(derive.directReviews({ ...input, ...change })).toEqual(directReviewFlows({ ...input, ...change }));
  expect(derive.directReviews({ ...input, nowMs: input.nowMs + 1000 })).not.toBe(first);
});

test("shared child index preserves traversal order, cycles and foreign-project boundaries", () => {
  const root = file("/repo/root", { parent: "/repo/child" });
  const files = [root, file("/repo/child", { parent: root.path }), file("/repo/foreign", { parent: root.path, project: "other", activity: "live" }), file("/repo/behind-foreign", { parent: "/repo/foreign" })];
  const kids = kidsIndex(files);
  expect(descendantsOf(root, files, kids)).toEqual(descendantsOf(root, files));
  expect(projectDescendantsOf(root, files, kids)).toEqual(projectDescendantsOf(root, files));
  expect(descendantsOf(root, files, kids).map(row => row.file.path)).toEqual(["/repo/foreign", "/repo/behind-foreign", "/repo/child"]);
  expect(projectDescendantsOf(root, files, kids).map(row => row.file.path)).toEqual(["/repo/child"]);
});

test("layout clock key follows exact pipeline horizon, aliases, live exemptions and pinning", () => {
  const derive = createProjectDashboardDerivation();
  const pipeline = {
    id: "lane", task: "Lane", taskIds: [], project: "atlas", repoDir: "/repo", worktreeDir: "/repo/tree", branch: "lane", baseBranch: "main",
    baseRef: "a", lastPassedCommit: "a", stages: [{ id: "build", kind: "run", next: null, prompt: "build", effectiveRole: { engine: "claude", model: "", effort: "", access: "read-write", roleId: null, promptScaffold: null } }],
    runs: [{ stageId: "build", attempts: [{ n: 1, state: "failed", agentPath: "/previous/agent.jsonl", startedAt: new Date(NOW * 1000).toISOString(), completedAt: new Date(NOW * 1000).toISOString() }] }],
    state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: new Date(NOW * 1000).toISOString(), closedAt: null,
    cursor: { stageId: "build", state: "failed", input: null, activatedBy: null },
  } as unknown as Pipeline;
  const planned = { ...pipeline, runs: [] };
  const at = (now: number) => derive.layout([], [], [], [], [], [planned], [planned], new Set(), new Set(), [], new Set(), { now, ageHorizonSeconds: 100 });
  expect(at(NOW + 100).slots.length).toBeGreaterThan(0);
  expect(at(NOW + 100.001).slots).toHaveLength(0);
  expect(at(0).slots.length).toBeGreaterThan(0);
  const idle = file("/current/agent.jsonl");
  for (const files of [[idle], [{ ...idle, mtime: NOW + 1000 }], [{ ...idle, activity: "live" as const }], [{ ...idle, proc: "running" as const }], [],
    [idle, file("/ambiguous/agent.jsonl")], [idle, { ...idle, mtime: NOW + 2000 }], [{ ...idle, mtime: NOW + 3000 }, idle]]) {
    for (const manual of [[], files]) {
      for (const now of [0, NOW, NOW + 99.999, NOW + 100, NOW + 100.001, NOW + 10000, NOW]) {
        const args: Parameters<typeof buildSchemeLayout> = [[], manual, files, [], [], [pipeline], [pipeline], new Set(), new Set(), [], new Set(), { now, ageHorizonSeconds: 100 }];
        expect(derive.layout(...args)).toEqual(buildSchemeLayout(...args));
      }
    }
  }
});

test("flow expansion retains equal membership and expires without a catalog update", () => {
  const derive = createProjectDashboardDerivation();
  const host = file("/repo/host.jsonl");
  const paths = new Set([host.path]);
  const flow = { implementerPath: host.path, rounds: [] } as unknown as Flow;
  const input = { flows: [flow], files: [host], now: NOW, ageHorizonSeconds: 100 };
  const first = derive.flowExpansions(paths, input);
  expect(derive.flowExpansions(new Set(paths), { ...input, now: NOW + 100 })).toBe(first);
  for (const now of [0, NOW + 99.999, NOW + 100, NOW + 100.001, NOW + 10000, NOW]) {
    expect(derive.flowExpansions(paths, { ...input, now })).toEqual(boundFlowExpansions(paths, { ...input, now }));
  }
  expect(derive.flowExpansions(paths, { ...input, now: NOW + 101 }).size).toBe(0);
  const reviewer = file("/repo/reviewer.jsonl", { activity: "live", proc: "running" });
  const reviewed = { ...flow, rounds: [{ n: 1, reviewerPath: reviewer.path }] } as unknown as Flow;
  const flows = [reviewed];
  for (const files of [[host, reviewer], [{ ...host, mtime: NOW - 200 }, reviewer],
    [{ ...host, mtime: NOW - 200 }, { ...reviewer, activity: "idle" as const, proc: null }],
    [{ ...host, mtime: NOW + 200 }, { ...reviewer, activity: "idle" as const, proc: null }],
    [host], [], [host, host], [{ ...host, mtime: NOW - 200 }, host]]) {
    for (const now of [0, NOW, NOW + 100, NOW + 1000, NOW]) {
      const next = { files, flows, now, ageHorizonSeconds: 100 };
      expect(derive.flowExpansions(paths, next)).toEqual(boundFlowExpansions(paths, next));
    }
  }
});

test("placement path memberships retain identity across payload refresh and follow arrivals/removal", () => {
  const derive = createProjectDashboardDerivation();
  const a = file("/repo/a"), b = file("/repo/b");
  const pinned = derive.pinnedPaths([a.path]);
  expect(derive.pinnedPaths([a.path])).toBe(pinned);
  expect(derive.pinnedPaths([b.path])).toEqual(new Set([b.path]));
  const collapsed = derive.collapsedPaths([a]);
  expect(derive.collapsedPaths([{ ...a, size: 100 }])).toBe(collapsed);
  const expanded = derive.keepExpandedPaths([a, b], collapsed);
  expect(derive.keepExpandedPaths([{ ...a, size: 100 }, b], collapsed)).toBe(expanded);
  expect(derive.keepExpandedPaths([a], collapsed)).toEqual(new Set());
  expect(derive.collapsedPaths([])).toEqual(new Set());
});

test("shared claim lookup follows deletion, ambiguity, reordering and row replacement", () => {
  const files = [{ path: "/current/project/session.jsonl" }];
  const alias = "/previous/project/session.jsonl";
  const first = transcriptClaimResolver(files);
  expect(first(alias)).toBe(files[0].path);
  expect(transcriptClaimResolver(files)).toBe(first);
  files.push({ path: "/duplicate/project/session.jsonl" });
  expect(transcriptClaimResolver(files)(alias)).toBe(alias);
  files.reverse();
  expect(transcriptClaimResolver(files)(alias)).toBe(alias);
  files.pop();
  expect(transcriptClaimResolver(files)(alias)).toBe("/duplicate/project/session.jsonl");
  files[0] = { path: "/replacement/project/session.jsonl" };
  expect(transcriptClaimResolver(files)(alias)).toBe(files[0].path);
  files.length = 0;
  expect(transcriptClaimResolver(files)(alias)).toBe(alias);
  expect(transcriptClaimResolver([{ path: "/fresh/project/session.jsonl" }])(alias)).toBe("/fresh/project/session.jsonl");
});
