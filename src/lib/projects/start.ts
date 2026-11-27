import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import {
  McpToolRefusal, openAsyncMcpReceiptStore, receiptKey, requestDigest,
  type McpRequestBinding, type McpToolPayload, type ProjectStartReceiptStore,
} from "@/lib/mcp/server";
import { mandatePreflight } from "@/lib/orchestrator/handoffDigest";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";
import { orchestratorRelayPayload, resolveOrchestratorRelay } from "@/lib/orchestrator/relay";
import { activeSeatCommandDependencies, executeOrchestratorSeatRequest, reconcileOrchestratorSeatLaunch } from "@/lib/orchestrator/seatCommand";
import { orchestratorSeatForOrUnknown } from "@/lib/orchestrator/seats";
import { operatorTimeZone } from "@/lib/operator/settings";
import { assertSafeRepositoryRoot, preparePipelineRepository, recoverProjectRepository, type RepositoryInitializationOperation } from "@/lib/pipelines/initializeRepository";
import { preflightPipelineRepo } from "@/lib/pipelines/preflight";
import { loadPipelinesForTask } from "@/lib/pipelines/store";
import { captureProcessIdentity, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import { lookupOriginalSend } from "@/lib/runtime/sendSettlement";
import { assertStructuredTextEnvelope } from "@/lib/runtime/structuredContent";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import { projectRootForCwd } from "@/lib/scanner/describe";
import { knownProjectFileRootsForProject } from "@/lib/scanner/projectDirectories";
import { waitForStateLock } from "@/lib/state/lockWait";
import { createTask } from "@/lib/tasks/commands";
import { taskMutationView } from "@/lib/tasks/mutationView";
import { taskSeatHoldingSnapshot } from "@/lib/tasks/seatHolding";
import { loadTasksByIds, mutateTasksFile, withTaskPreparation } from "@/lib/tasks/store";
import { cleanWorkspaceName, isWorkspaceId, workspaceNameKey } from "@/lib/team/contract";
import { existingTeamStore } from "@/lib/team/store";
import { workspaceCatalog, placeCreatedProject, workspaceDirectory } from "@/lib/team/workspaces";
import { workspacePrincipalAllows } from "@/lib/team/workspacePrincipal";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { canonicalProject } from "./aliases";
import { createManualProject, projectStartRegistration } from "./curation";
import { boundedTarget } from "./directorySuggestions";
import { folderName } from "./folderName";
import { isCanonicalProjectId, localRepositoryProjectId, repositoryRootForPath } from "./identity";
import {
  assertProjectStartRoot, assertProjectStartSeat, assertProjectStartSource, assertProjectStartTarget,
  projectStartDirectory, projectStartIdentity, projectStartNative, projectStartRuntime, ProjectStartRefusal, sameDirectory,
} from "./startAuthority";
import { PROJECT_START_ROLE, projectStartKey, type ProjectStartCheckpoint, type ProjectStartSource, type StartProjectInput } from "./startContract";
import { readProjectStartLink } from "./startReceipt";
import { defaultProjectsParent, suggestionRoots } from "./suggestionRoots";

const DEADLINE_MS = 15 * 60_000;
const RECHECK_MS = 2_000;
const BATCH = 8;
const marker = ".delegatus-initialization-project-start";
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

function refusalDetails(error: ProjectStartRefusal) {
  return { code: error.code, status: error.status, retryable: error.retryable, ...(error.field ? { field: error.field } : {}) };
}

function publicResult(checkpoint: ProjectStartCheckpoint): McpToolPayload {
  const { operationId, phase, project, taskId, seat, launchId, messageOperationId, arrival, work, effects, cause } = checkpoint;
  return {
    operationId, accepted: true, state: checkpoint.disposition, phase, project, taskId, launchId, messageOperationId,
    seat: seat && { conversationId: seat.conversationId, seatEpoch: seat.seatEpoch, reused: seat.reused },
    arrival, work, effects,
    ...(cause ? { cause, nextAction: checkpoint.nextAt === null ? "manual-check" : "original-key-lookup" } : {}),
  };
}

function workspaceFor(input: StartProjectInput, source: ProjectStartSource): void {
  if (input.workspaceId !== undefined && (!isWorkspaceId(input.workspaceId) || input.workspaceId !== source.workspace?.workspaceId))
    throw new ProjectStartRefusal("workspace_forbidden", 403, "workspaceId");
  if (source.workspace && input.target.kind === "new_project" && input.target.folder.mode !== "by_name")
    throw new ProjectStartRefusal("workspace_forbidden", 403, "target.folder");
}

function selectedDirectory(raw: string, roots: readonly string[]): string {
  if (!path.isAbsolute(raw) || path.resolve(raw) !== raw || raw.includes("\0"))
    throw new ProjectStartRefusal("INVALID_ROOT", 400, "target.folder");
  if (boundedTarget(raw, roots) !== raw) throw new ProjectStartRefusal("OUTSIDE_ROOTS", 400, "target.folder");
  return raw;
}

function nearestParent(root: string): ProjectStartCheckpoint["parent"] {
  for (let candidate = path.dirname(root); ; candidate = path.dirname(candidate)) {
    const identity = projectStartDirectory(candidate);
    if (identity) return { path: candidate, identity };
    if (candidate === path.dirname(candidate)) throw new ProjectStartRefusal("INVALID_ROOT", 400);
  }
}

function createProjectStartFolder(checkpoint: ProjectStartCheckpoint, assert: () => void): void {
  const parts = path.relative(checkpoint.parent.path, checkpoint.root).split(path.sep);
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let current = checkpoint.parent.path;
  let held = fs.openSync(current, flags);
  const anchored = () => process.platform === "linux" ? `/proc/self/fd/${held}` : current;
  try {
    if (!sameDirectory(fs.fstatSync(held), checkpoint.parent.identity)) throw new ProjectStartRefusal("target_changed");
    for (const part of parts) {
      assert();
      if (!sameDirectory(fs.fstatSync(held), projectStartDirectory(current))) throw new ProjectStartRefusal("target_changed");
      const child = path.join(anchored(), part);
      if (repositoryRootForPath(current)) throw new ProjectStartRefusal("PARENT_IN_REPOSITORY", 400);
      fs.mkdirSync(child);
      const next = fs.openSync(child, flags);
      fs.closeSync(held);
      held = next;
      current = path.join(current, part);
    }
    assert();
    const stat = fs.fstatSync(held);
    const identity = { dev: stat.dev, ino: stat.ino };
    if (!sameDirectory(identity, projectStartDirectory(checkpoint.root))) throw new ProjectStartRefusal("target_changed");
    fs.writeFileSync(path.join(anchored(), marker), JSON.stringify({ token: checkpoint.folderToken, identity }), { flag: "wx", mode: 0o600 });
  } finally { fs.closeSync(held); }
}

function taskBrief(id: string): string {
  return `Begin work on task ${id}. Read the existing card with get_task and use its details and the project's normal workflow.`;
}

function checkFreshSeat(project: string): string {
  const { engine, digest } = projectStartRuntime();
  if (activeSeatCommandDependencies().engineReadiness?.(engine, project) !== "connected")
    throw new ProjectStartRefusal("engine_not_connected", 409);
  if (!mandatePreflight(ORCHESTRATOR_SYSTEM_PROMPT, "spawn", PROJECT_START_ROLE).ok)
    throw new ProjectStartRefusal("mandate_too_large", 413);
  return digest;
}

async function planStart(input: ProjectStartCheckpoint["input"], source: ProjectStartSource, id: string, assertCaller: () => void): Promise<ProjectStartCheckpoint> {
  workspaceFor(input, source);
  const roots = suggestionRoots();
  const target = input.target;
  let root: string;
  let originalProject: string;
  let directory: ProjectStartCheckpoint["directory"];
  let repositoryPresent = false;
  if (target.kind === "existing_project") {
    originalProject = target.project;
    if (!isCanonicalProjectId(originalProject) || canonicalProject(originalProject) !== originalProject)
      throw new ProjectStartRefusal("unknown_project", 404, "target.project");
    if (source.workspace && !workspacePrincipalAllows(source.workspace, originalProject))
      throw new ProjectStartRefusal("workspace_forbidden", 403);
    const unique = [...new Set(knownProjectFileRootsForProject(originalProject).map(candidate => projectRootForCwd(candidate) ?? candidate))];
    if (unique.length !== 1 || !unique[0]) throw new ProjectStartRefusal("project_directory_unavailable", 409);
    root = selectedDirectory(unique[0], roots);
    directory = projectStartDirectory(root);
    if (!directory || projectStartIdentity(root) !== originalProject) throw new ProjectStartRefusal("target_changed");
  } else {
    const clean = cleanWorkspaceName(target.name);
    const nameKey = clean ? workspaceNameKey(clean) : "";
    if (!clean || !nameKey) throw new ProjectStartRefusal("INVALID_NAME", 400, "target.name");
    if (workspaceCatalog().projects.some(row => {
      if (source.workspace && !workspacePrincipalAllows(source.workspace, row.project)) return false;
      const name = cleanWorkspaceName(row.displayName);
      return name && workspaceNameKey(name) === nameKey;
    })) throw new ProjectStartRefusal("DUPLICATE_NAME");
    const folder = target.folder;
    root = selectedDirectory(folder.mode === "by_name" ? path.join(defaultProjectsParent(), folderName(clean)) : folder.root, roots);
    directory = projectStartDirectory(root);
    if (folder.mode === "reuse" && !directory) throw new ProjectStartRefusal("MISSING_DIRECTORY", 400);
    if (folder.mode !== "reuse" && directory) throw new ProjectStartRefusal("DUPLICATE_PROJECT");
    originalProject = projectStartIdentity(root);
    if (canonicalProject(originalProject) !== originalProject
      || workspaceCatalog().projects.some(row => row.project === originalProject)
      || existingTeamStore()?.workspaceProjectRows().some(row => canonicalProject(row.project) === originalProject))
      throw new ProjectStartRefusal("DUPLICATE_PROJECT");
    if (folder.mode !== "reuse" && repositoryRootForPath(path.dirname(root))) throw new ProjectStartRefusal("PARENT_IN_REPOSITORY", 400);
  }
  const parent = nearestParent(root);
  const slot = orchestratorSeatForOrUnknown(originalProject);
  if (!slot) throw new ProjectStartRefusal("seat_unavailable", 503);
  if (slot.pending && !slot.pending.intent.error) throw new ProjectStartRefusal("seat_busy");
  let seat: ProjectStartCheckpoint["seat"] = null;
  let runtimeDigest: ProjectStartCheckpoint["runtimeDigest"] = null;
  if (slot.active) {
    if (target.kind !== "existing_project") throw new ProjectStartRefusal("DUPLICATE_PROJECT");
    const native = slot.active.conversationId && projectStartNative(slot.active.conversationId, originalProject);
    if (!native) throw new ProjectStartRefusal("seat_unavailable", 409);
    seat = { ...native, seatEpoch: slot.active.seatEpoch, reused: true };
  } else {
    runtimeDigest = checkFreshSeat(originalProject);
  }
  const reservedTaskId = crypto.randomUUID();
  const dueTimeZone = operatorTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const preview = createTask([], { ...input.task, project: originalProject, placement: "unplaced" }, [], {
    requireDue: true, dueTimeZone: dueTimeZone ?? undefined, id: () => reservedTaskId,
  });
  if (!preview.ok) throw new ProjectStartRefusal(preview.code ?? "task_invalid", preview.status, preview.field);
  const message = orchestratorRelayPayload(taskBrief(reservedTaskId), { conversationId: source.conversationId, project: source.project, path: null });
  if (message.origin.kind !== "agent" || message.origin.role !== "orchestrator" || !message.origin.project)
    throw new ProjectStartRefusal("caller_forbidden", 403);
  const relay = { text: message.text, origin: { kind: "agent", role: "orchestrator", project: message.origin.project, conversationId: source.conversationId } } as const;
  assertStructuredTextEnvelope(relay.text);
  await assertSafeRepositoryRoot(root).catch(() => { throw new ProjectStartRefusal("OUTSIDE_ROOTS", 400); });
  assertCaller();
  if (directory) {
    const check = await preflightPipelineRepo(root);
    assertCaller();
    if (!check.ok && check.code !== "not_git") throw new ProjectStartRefusal(check.code);
    if (check.ok && check.repoDir !== root) throw new ProjectStartRefusal("PARENT_IN_REPOSITORY", 400);
    repositoryPresent = check.ok;
  }
  if (!repositoryPresent && process.platform !== "linux" && process.platform !== "darwin")
    throw new ProjectStartRefusal("initialization_refused");
  const now = Date.now();
  const checkpoint: ProjectStartCheckpoint = {
    version: 1, operationId: id, input, source, root, parent, directory,
    folderToken: crypto.randomUUID(), placement: "not-started", prepared: null, repositoryPresent,
    originalProject, project: null, reservedTaskId, taskId: null, seat, launchId: null, messageOperationId: null, relay,
    phase: "admission", effects: { folder: "not-started", registration: "not-started", repository: "not-started", task: "not-started", seat: "not-started", delivery: "not-started" },
    arrival: "pending", arrivedAt: null, work: { state: "pending", pipelineIds: [], launchIds: [] }, disposition: "accepted", cause: null,
    dueTimeZone, mandate: ORCHESTRATOR_SYSTEM_PROMPT, mandateVersion: ORCHESTRATOR_PROMPT_VERSION, runtimeDigest,
    nextAt: now, deadline: now + DEADLINE_MS,
  };
  assertProjectStartRoot(checkpoint);
  return checkpoint;
}

export async function startProject(input: StartProjectInput, source: ProjectStartSource, assertCaller: () => void, store: ProjectStartReceiptStore,
  retainDisclosure: (check: () => void) => void = () => {}): Promise<McpToolPayload> {
  const assert = () => { assertCaller(); assertProjectStartSource(source); };
  const key = receiptKey("start_project", input.clientRequestId, source.conversationId);
  const { recoveryOnly, ...argumentsForDigest } = input;
  const digest = requestDigest("start_project", argumentsForDigest);
  const disclose = (checkpoint: ProjectStartCheckpoint) => {
    assert();
    const project = checkpoint.project ?? (checkpoint.input.target.kind === "existing_project" ? checkpoint.originalProject : null);
    const target = { ...checkpoint, project };
    if (project) assertProjectStartTarget(target);
    else assertProjectStartRoot(target);
    if (checkpoint.seat) assertProjectStartSeat(target);
  };
  const inspect = async (): Promise<McpToolPayload | null> => {
    assert();
    const record = await store.lookup(key);
    assert();
    if (!record) return null;
    const checkpoint = record.binding?.projectStart;
    if (!checkpoint || JSON.stringify(checkpoint.source) !== JSON.stringify(source)) throw new ProjectStartRefusal("authority_changed", 403);
    if (record.digest !== digest) throw new ProjectStartRefusal("idempotency_conflict");
    const disclosure = () => disclose(checkpoint);
    disclosure();
    retainDisclosure(disclosure);
    return { ...publicResult(checkpoint), replayed: true };
  };
  try {
    const held = await inspect();
    if (held) return held;
    if (recoveryOnly) throw new ProjectStartRefusal("outcome_unknown", 409, undefined, true);
    const id = hash(key);
    const checkpoint = await planStart(argumentsForDigest, source, id, assert);
    const owner = captureProcessIdentity(process.pid);
    const binding: McpRequestBinding = {
      version: 1, toolName: "start_project", clientRequestId: input.clientRequestId,
      caller: { kind: "worker", conversationId: source.conversationId, project: source.project },
      target: { project: checkpoint.originalProject, identity: id },
      downstreamKey: id, owner, claimGeneration: crypto.randomUUID(), claimedAt: new Date().toISOString(), projectStart: checkpoint,
    };
    const claim = await store.claim(key, digest, "durable", binding, () => disclose(checkpoint));
    assert();
    if (claim.kind !== "fresh") {
      const replay = await inspect();
      if (replay) return replay;
      throw new ProjectStartRefusal("outcome_unknown", 409, undefined, true);
    }
    disclose(checkpoint);
    retainDisclosure(() => disclose(checkpoint));
    return publicResult(checkpoint);
  } catch (error) {
    if (error instanceof ProjectStartRefusal) throw new McpToolRefusal(error.code, {
      ...refusalDetails(error),
      ...(error.code === "outcome_unknown" ? { outcome: "unknown", evidence: "none", nextAction: "original-key-lookup" } : {}),
    });
    throw error;
  }
}

type Effect = keyof ProjectStartCheckpoint["effects"];
const observed = (effect: ProjectStartCheckpoint["effects"][Effect]) => effect === "observed" || effect === "reused";
const finished = { nextAt: null, phase: "settled" } as const;

export async function advanceProjectStart(store: ProjectStartReceiptStore, key: string, messageClient?: () => RuntimeHostClient | null): Promise<void> {
  const record = await store.lookup(key);
  let binding = record?.binding;
  if (!record || !binding?.projectStart || binding.projectStart.nextAt === null) return;
  let checkpoint = binding.projectStart;
  const owner = captureProcessIdentity(process.pid);
  const { digest } = record;
  const release = () => {
    if (!viewerReleaseOwnsTraffic()) throw new ProjectStartRefusal("release_changed", 503, undefined, true);
  };
  const assert = () => {
    release();
    const current = readProjectStartLink(checkpoint.operationId);
    if (!current || current.claimGeneration !== binding?.claimGeneration)
      throw new ProjectStartRefusal("project_start_owner_changed", 409, undefined, true);
    assertProjectStartSource(checkpoint.source);
    assertProjectStartRoot(checkpoint);
    if (checkpoint.project) assertProjectStartTarget(checkpoint);
    if (checkpoint.seat) assertProjectStartSeat({ ...checkpoint, project: checkpoint.project ?? checkpoint.originalProject });
    if (!checkpoint.project && checkpoint.source.workspace && observed(checkpoint.effects.registration)
      && !workspacePrincipalAllows(checkpoint.source.workspace, canonicalProject(checkpoint.originalProject)))
      throw new ProjectStartRefusal("workspace_forbidden", 403);
    if (checkpoint.deadline <= Date.now()) throw new ProjectStartRefusal("project_start_deadline");
  };
  const save = async (patch: Partial<ProjectStartCheckpoint>, guard = assert, transfer = false) => {
    const next = { ...checkpoint, ...patch };
    const updated = { ...binding!, ...(transfer ? { owner, claimGeneration: crypto.randomUUID() } : {}), projectStart: next };
    if (!await store.updateProjectStart(key, digest, binding!, updated, guard)) throw new ProjectStartRefusal("project_start_owner_changed", 409, undefined, true);
    checkpoint = next;
    binding = updated;
  };
  const mark = (step: Effect, effect: ProjectStartCheckpoint["effects"][Effect], phase: ProjectStartCheckpoint["phase"] = step) =>
    save({ phase, disposition: "in-progress", effects: { ...checkpoint.effects, [step]: effect } });
  const waiting = (phase: ProjectStartCheckpoint["phase"], unknown = false) => save({
    nextAt: Date.now() + RECHECK_MS, phase, disposition: unknown ? "unknown" : "in-progress",
    cause: unknown ? { code: "outcome_unknown", retryable: true } : null,
    ...(phase === "delivery" ? { arrival: unknown ? "unknown" : "pending" } : {}),
  });
  const uncertain = () => new ProjectStartRefusal("project_start_custody_unavailable");
  let effect: Effect | null = null;
  try {
    release();
    if (!sameRecordedProcessIdentity(binding.owner, owner)) await save({}, release, true);
    assert();
    const { root, originalProject, input, operationId, source } = checkpoint;
    if (!observed(checkpoint.effects.folder)) {
      effect = "folder";
      if (checkpoint.directory) {
        await mark("folder", "reused");
      } else {
        const dispatched = checkpoint.effects.folder === "dispatching";
        if (!dispatched) {
          await mark("folder", "dispatching");
          assert();
          if (projectStartDirectory(root)) throw new ProjectStartRefusal("DUPLICATE_PROJECT");
          createProjectStartFolder(checkpoint, assert);
        }
        const directory = projectStartDirectory(root);
        if (!directory) throw uncertain();
        const saved = fs.openSync(path.join(root, marker), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(saved);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024
            || fs.readFileSync(saved, "utf8") !== JSON.stringify({ token: checkpoint.folderToken, identity: directory })) throw uncertain();
        } finally { fs.closeSync(saved); }
        await save({ directory, effects: { ...checkpoint.effects, folder: "observed" } });
      }
    }

    if (!observed(checkpoint.effects.registration)) {
      effect = "registration";
      if (input.target.kind === "existing_project") {
        await mark("registration", "reused");
      } else {
        const dispatched = checkpoint.effects.registration === "dispatching";
        if (!dispatched) {
          await mark("registration", "dispatching");
          assert();
          if (projectStartIdentity(root) !== originalProject) throw new ProjectStartRefusal("target_changed");
          const result = createManualProject(input.target.name, root, new Set(workspaceCatalog().projects.map(row => row.project)), {
            allowedRoots: suggestionRoots(), projectStart: { id: operationId, assertCurrent: assert },
          });
          if (!result.ok) throw new ProjectStartRefusal(result.code);
        }
        const saved = projectStartRegistration(originalProject, operationId);
        if (!saved || saved.root !== root || saved.displayName !== input.target.name) throw uncertain();
        if (source.workspace && !observed(checkpoint.placement)) {
          const placement = checkpoint.placement;
          if (placement !== "dispatching") await save({ placement: "dispatching" });
          assert();
          const team = existingTeamStore();
          const member = team?.member(source.workspace.memberId);
          if (!team || !member) throw new ProjectStartRefusal("workspace_forbidden", 403);
          const observedWorkspace = workspaceDirectory(team).workspaceOf(originalProject);
          if (observedWorkspace !== source.workspace.workspaceId) {
            if (placement === "dispatching" || observedWorkspace) throw uncertain();
            assert();
            placeCreatedProject(team, member, originalProject, source.workspace.workspaceId, { assertCurrent: assert });
          }
          await save({ placement: "observed" });
        }
        await mark("registration", "observed");
      }
    }

    if (!observed(checkpoint.effects.repository)) {
      effect = "repository";
      const dispatched = checkpoint.effects.repository === "dispatching";
      if (!dispatched) await mark("repository", "dispatching");
      const operation: RepositoryInitializationOperation = {
        id: operationId, assertCurrent: assert, prepared: checkpoint.prepared,
        recordPrepared: prepared => save({ prepared }),
      };
      const ready = checkpoint.repositoryPresent ? await preflightPipelineRepo(root)
        : dispatched ? await recoverProjectRepository(root, operation)
          : await preparePipelineRepository(root, true, {}, operation);
      assert();
      if (!ready) throw uncertain();
      if (!ready.ok) {
        if (checkpoint.prepared) throw uncertain();
        throw new ProjectStartRefusal(ready.code);
      }
      const project = projectStartIdentity(root);
      const expected = checkpoint.prepared ? localRepositoryProjectId(root) : originalProject;
      if (ready.repoDir !== root || !expected || project !== expected || canonicalProject(originalProject) !== project)
        throw new ProjectStartRefusal("target_changed");
      const complete = { ...checkpoint, project };
      assertProjectStartTarget(complete);
      await save({ project, phase: "identity", effects: { ...checkpoint.effects, repository: checkpoint.prepared ? "observed" : "reused" } });
    }

    const project = checkpoint.project!;
    if (!checkpoint.seat) {
      const slot = orchestratorSeatForOrUnknown(project);
      const expected = projectStartKey("seat", operationId);
      if (!slot || slot.active && slot.active.intent.clientRequestId !== expected
        || slot.pending && !slot.pending.intent.error && slot.pending.intent.clientRequestId !== expected)
        throw new ProjectStartRefusal("already_designated");
    }
    if (!observed(checkpoint.effects.task)) {
      effect = "task";
      const dispatched = checkpoint.effects.task === "dispatching";
      if (!dispatched) await mark("task", "dispatching");
      const id = checkpoint.reservedTaskId;
      const author = { kind: "agent", role: "orchestrator", conversationId: source.conversationId } as const;
      const result = await withTaskPreparation(() => waitForStateLock("projects.start.task", () => mutateTasksFile(state => {
        assert();
        const current = taskMutationView(state.tasks)?.get(id) ?? state.tasks.find(row => row.id === id);
        if (current) {
          if (canonicalProject(current.project) !== project || current.createdAt < binding!.claimedAt)
            throw new ProjectStartRefusal("target_changed");
          return { state: undefined, result: id };
        }
        if (dispatched) throw uncertain();
        const created = createTask(state.tasks, { ...input.task, project, placement: "unplaced", clientRequestId: projectStartKey("task", operationId) }, state.recentCreates, {
          requireDue: true, dueTimeZone: checkpoint.dueTimeZone ?? undefined, explicit: true,
          actor: "agent", noteAuthor: { kind: "orchestrator", conversationId: source.conversationId },
          conversationId: source.conversationId, seatHolding: taskSeatHoldingSnapshot(), statusActor: author, id: () => id,
        });
        if (!created.ok) throw new ProjectStartRefusal(created.code ?? "task_invalid", created.status, created.field);
        if (created.task.id !== id) throw uncertain();
        assert();
        return { result: id, state: { tasks: created.tasks, recentCreates: created.recentCreates } };
      }), { subject: "tasks" }));
      await save({ taskId: result, effects: { ...checkpoint.effects, task: "observed" } });
    }

    if (!observed(checkpoint.effects.seat)) {
      effect = "seat";
      if (checkpoint.seat) {
        assertProjectStartSeat(checkpoint);
        await mark("seat", "reused");
      } else {
        const clientRequestId = projectStartKey("seat", operationId);
        if (checkpoint.effects.seat === "not-started") {
          await mark("seat", "dispatching");
          const assertSeatAdmission = () => {
            assert();
            if (checkFreshSeat(project) !== checkpoint.runtimeDigest) throw new ProjectStartRefusal("role_changed");
          };
          assertSeatAdmission();
          const slot = orchestratorSeatForOrUnknown(project);
          if (!slot || slot.active || slot.pending && !slot.pending.intent.error) throw new ProjectStartRefusal("already_designated");
          const result = await executeOrchestratorSeatRequest({
            project, cwd: root, mandate: checkpoint.mandate, promptVersion: checkpoint.mandateVersion, clientRequestId,
          }, activeSeatCommandDependencies(),
          { kind: "agent", conversationId: source.conversationId, seatEpoch: source.seatEpoch },
          { autonomous: true, workspace: source.workspace ?? undefined, assertAccount: assertSeatAdmission, assertProjectStart: assertSeatAdmission });
          assert();
          if (result.status >= 400 && result.body.admission === "refused")
            throw new ProjectStartRefusal(safeCode(result.body.code, "seat_refused"), result.status);
        }
        const registry = agentRegistry();
        const receipt = registry.spawnReceiptForClientAttempt(clientRequestId);
        if (receipt?.state === "failed" && receipt.rejection) throw new ProjectStartRefusal(safeCode(receipt.rejection.code, "seat_refused"));
        const slot = orchestratorSeatForOrUnknown(project);
        const intent = slot?.active ?? slot?.pending;
        if (!intent || intent.intent.clientRequestId !== clientRequestId
          || intent.triggeredBy?.conversationId !== source.conversationId || intent.triggeredBy.seatEpoch !== source.seatEpoch) throw uncertain();
        if (receipt && checkpoint.launchId !== receipt.launchId) await save({ launchId: receipt.launchId });
        if (!receipt || receipt.state !== "completed") { await waiting("mandate", !receipt); return; }
        if (!slot?.active) {
          assert();
          await reconcileOrchestratorSeatLaunch(project);
          assert();
        }
        const active = orchestratorSeatForOrUnknown(project)?.active;
        const native = active?.conversationId === receipt.conversationId && projectStartNative(receipt.conversationId, project);
        if (!active || active.intent.clientRequestId !== clientRequestId || !native) { await waiting("mandate"); return; }
        const mandate = lookupOriginalSend(registry.deliverySnapshotForMessageKey(receipt.conversationId, `spawn_${receipt.launchId}`),
          { conversationId: receipt.conversationId, clientMessageId: `spawn_${receipt.launchId}` });
        if (mandate.kind !== "found" || mandate.receipt.state !== "delivered" || !mandate.receipt.settledAt) { await waiting("mandate"); return; }
        await save({ seat: { ...native, seatEpoch: active.seatEpoch, reused: false }, effects: { ...checkpoint.effects, seat: "observed" } });
      }
    }

    const seat = checkpoint.seat!;
    assertProjectStartSeat(checkpoint);
    if (!observed(checkpoint.effects.delivery)) {
      effect = "delivery";
      const clientMessageId = projectStartKey("message", operationId);
      const payload = checkpoint.relay;
      if (checkpoint.effects.delivery === "not-started") {
        await mark("delivery", "dispatching");
        const guard = () => { assert(); assertProjectStartSeat(checkpoint); };
        guard();
        const registry = agentRegistry();
        const path = registry.sessionTarget(seat.conversationId, "");
        if (path.unavailable || !path.path) throw new ProjectStartRefusal("seat_unavailable");
        const resolved = resolveOrchestratorRelay(project, seat.conversationId, payload, taskBrief(checkpoint.taskId!), clientMessageId);
        if (!resolved.ok) throw new ProjectStartRefusal(resolved.code, resolved.status);
        const sent = await enqueueStructuredMessage({
          ...payload, path: path.path, conversationId: seat.conversationId, clientMessageId, operationId: clientMessageId,
          policy: "queue", admissionGuard: guard, recoveryAuthorityGuard: guard,
        }, { authorizeBeforeWrite: guard, ...(messageClient ? { enabled: () => true, client: messageClient } : {}) });
        guard();
        if (sent?.operationId) await save({ messageOperationId: sent.operationId });
        if (sent && !sent.ok && sent.admission === "refused") throw new ProjectStartRefusal(safeCode(sent.code, "delivery_refused"), sent.status);
      }
      const registry = agentRegistry();
      const arrival = lookupOriginalSend(registry.deliverySnapshotForMessageKey(seat.conversationId, clientMessageId),
        { ...payload, conversationId: seat.conversationId, clientMessageId });
      if (arrival.kind !== "found") { await waiting("delivery", true); return; }
      if (arrival.receipt.state !== "delivered" || !arrival.receipt.settledAt) {
        await waiting("delivery", arrival.receipt.state === "failed");
        return;
      }
      await save({
        messageOperationId: arrival.operationId, arrival: "confirmed", arrivedAt: arrival.receipt.settledAt,
        phase: "work", effects: { ...checkpoint.effects, delivery: "observed" },
      });
    }

    assert();
    assertProjectStartSeat(checkpoint);
    const tasks = loadPipelinesForTask(checkpoint.taskId!);
    const arrivalTime = Date.parse(checkpoint.arrivedAt ?? "");
    const work = tasks.filter(lane => lane.state !== "draft" && lane.creationRequest && lane.srcConversationId === seat.conversationId
      && canonicalProject(lane.project) === project && lane.taskIds.includes(checkpoint.taskId!)
      && Date.parse(lane.createdAt) >= arrivalTime);
    const task = loadTasksByIds(new Set([checkpoint.taskId!]))[0];
    const registry = agentRegistry();
    const launches = (task?.assignments ?? []).flatMap(assignment => {
      if (!assignment.launchId || !assignment.clientAttemptId) return [];
      const launch = registry.spawnReceipt(assignment.launchId);
      return launch && !launch.rejection && launch.state !== "failed" && launch.state !== "conflicted"
        && launch.clientAttemptId === assignment.clientAttemptId && launch.parentConversationId === seat.conversationId
        && launch.launchProfile.project === project && Date.parse(launch.createdAt) >= arrivalTime ? [launch.launchId] : [];
    });
    if (!work.length && !launches.length) { await waiting("work"); return; }
    await save({
      ...finished, disposition: "started", cause: null,
      work: { state: "admitted", pipelineIds: work.map(lane => lane.id), launchIds: launches },
    });
  } catch (error) {
    if (error instanceof ProjectStartRefusal && (error.code === "release_changed" || error.code === "project_start_owner_changed")) return;
    const reason = error instanceof ProjectStartRefusal ? error : new ProjectStartRefusal(isMissing(error) ? "project_start_custody_unavailable" : "project_start_interrupted");
    const unknown = ["project_start_custody_unavailable", "project_start_deadline", "project_start_interrupted"].includes(reason.code);
    const effects = { ...checkpoint.effects };
    // A launch/dispatch window keeps its uncertainty even if current
    // authority positively refuses further work.
    if (effect && effects[effect] === "dispatching") effects[effect] = unknown || ["authority_changed", "target_changed", "workspace_forbidden"].includes(reason.code) ? "unknown" : "refused";
    await save({
      nextAt: null, disposition: unknown ? "unknown" : "partial", effects,
      cause: refusalDetails(reason), ...(effects.delivery === "unknown" ? { arrival: "unknown" } : {}),
    }, release);
  }
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/i.test(value) ? value : fallback;
}

let controller: ReturnType<typeof setTimeout> | null = null;
export function startProjectController(): void {
  if (controller || !viewerReleaseOwnsTraffic()) return;
  let cursor = "";
  let store: Awaited<ReturnType<typeof openAsyncMcpReceiptStore>> | undefined;
  const tick = async () => {
    if (!viewerReleaseOwnsTraffic()) { store?.close(); controller = null; return; }
    try {
      await withViewerOperation("projects.start", async () => {
        const receipts = store ??= await openAsyncMcpReceiptStore(statePath("mcp-receipts.sqlite"));
        const keys = await receipts.pendingProjectStarts(Date.now(), cursor, BATCH);
        for (const key of keys) {
          if (!viewerReleaseOwnsTraffic()) break;
          cursor = key;
          try { await advanceProjectStart(receipts, key); }
          catch { console.warn("[project start] checkpoint advance deferred"); }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (keys.length < BATCH) cursor = "";
      });
    } catch { console.warn("[project start] receipt scan deferred"); }
    controller = setTimeout(() => void tick(), RECHECK_MS);
    controller.unref?.();
  };
  controller = setTimeout(() => void tick(), 0);
  controller.unref?.();
}
