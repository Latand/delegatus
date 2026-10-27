import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { operatorBrowserRequest } from "@/lib/agent/operatorAuthority";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { projectForCwd } from "@/lib/scanner/describe";
import { canonicalProject } from "@/lib/projects/aliases";
import { assignmentHoldsIdentity } from "@/lib/tasks/membership";
import { loadTasksByIds } from "@/lib/tasks/store";
import { assertWorkspaceProject, requestWorkspaceScope } from "@/lib/team/workspaceRoute";
import { hardenedRedact } from "@/lib/view/compactText";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { realExec, type ExecPort } from "@/lib/workflows/provision";
import { readMessagesPage, type MessagesPageCursor } from "@/lib/session/messagesPage";
import { normalizeSessionLine } from "@/lib/session/reader";
import type { PinnedTranscript } from "@/lib/mcp/bindings";

import type { ConversationDraftPreview, ConversationDraftRequest } from "./conversationDraftContract";
import { createPipelineFromRequest, defaultPipelinePorts, type PipelinePorts, type PipelineMutationResult } from "./engine";
import { MAX_STAGE_PROMPT_LENGTH, MAX_TASK_LENGTH } from "./limits";
import { preflightPipelineRepo } from "./preflight";
import { pipelineBaseBranchError } from "./git";
import { pipelineDeliveryLookup } from "./store";
import type { Pipeline } from "./types";

export class ConversationDraftRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 409, readonly retryable = false) {
    super(message);
  }
}

function refuse(code: string, message: string, status = 409): never { throw new ConversationDraftRefusal(code, message, status); }
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clip = (value: string, maximum: number) => {
  let text = value.slice(0, maximum);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text;
};
// Source quotations cannot become prompt wiring when renderStagePrompt runs.
const visible = (value: string, maximum: number) => clip(hardenedRedact(value).replaceAll("{{", "｛｛").replaceAll("}}", "｝｝"), maximum);

export function validateConversationDraftInput(raw: unknown, create: boolean): ConversationDraftRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) refuse("INVALID_REQUEST", "request must be an object", 400);
  const input = raw as Record<string, unknown>;
  const fields = create ? ["conversationId", "taskId", "sourceRevision", "clientRequestId"] : ["conversationId", "taskId"];
  if (Object.keys(input).some(key => !fields.includes(key))) refuse("INVALID_REQUEST", "unsupported request field", 400);
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > (field === "clientRequestId" ? 128 : 256)
      || /[\x00-\x1f]/u.test(value)) refuse("INVALID_REQUEST", `invalid ${field}`, 400);
  }
  if (!/^conversation_[A-Za-z0-9_-]{1,180}$/.test(input.conversationId as string)
    || (create && !/^[a-f0-9]{64}$/.test(input.sourceRevision as string))) refuse("INVALID_REQUEST", "invalid source identity", 400);
  return input as ConversationDraftRequest;
}

export interface ConversationDraftPorts {
  registry: ReturnType<typeof agentRegistry>;
  exec: ExecPort;
  open(pathname: string): Promise<PinnedTranscript | undefined>;
  metadata(pathname: string, signal: AbortSignal): Promise<{ cwd?: string | null; title?: string | null } | undefined>;
  pipeline: PipelinePorts;
  now(): string;
}

export function conversationDraftPorts(): ConversationDraftPorts {
  return {
    registry: agentRegistry(), exec: realExec, pipeline: defaultPipelinePorts(),
    open: async pathname => (await import("@/lib/mcp/bindings")).openPinnedTranscript(pathname),
    metadata: async (pathname, signal) => {
      const result = await (await import("@/lib/mcp/bindings")).targetedConversationAtPath(pathname, { tailLines: 1, signal });
      return result?.entry;
    },
    now: () => new Date().toISOString(),
  };
}

/** Every call reads live authority, including calls from inside storage admission. */
function authorize(req: NextRequest, projects: readonly (string | null)[] = []): void {
  if (!operatorBrowserRequest(req)) refuse("operator_required", "a verified operator browser session is required", 403);
  for (const project of projects) assertWorkspaceProject(req, project);
}

function boundSource(req: NextRequest, input: Pick<ConversationDraftRequest, "conversationId" | "taskId">, ports: ConversationDraftPorts) {
  authorize(req);
  const registry = ports.registry;
  const conversation = registry.conversation(input.conversationId as ViewerConversationId);
  if (!conversation) refuse("NOT_FOUND", "conversation not found", 404);
  const generation = conversation.generations.at(-1);
  const task = loadTasksByIds(new Set([input.taskId]))[0];
  if (!task) refuse("NOT_FOUND", "task not found", 404);
  const sourceProject = conversation.projectOwnership?.project ?? (generation?.launchProfile.cwd ? projectForCwd(generation.launchProfile.cwd) : null);
  authorize(req, [sourceProject, task.project]);
  if (sourceProject && canonicalProject(sourceProject) !== canonicalProject(task.project)) refuse("SOURCE_PROJECT_MISMATCH", "source and task belong to different projects");
  const holds = task.assignments.some(assignment => assignmentHoldsIdentity({
    ...assignment,
    conversationId: assignment.conversationId ? registry.canonicalConversationId(assignment.conversationId as ViewerConversationId) : assignment.conversationId,
  }, { conversationId: conversation.id, path: generation?.path }));
  if (!holds) refuse("SOURCE_NOT_ON_TASK", "the task no longer holds this conversation");
  if (!generation?.path) refuse("SOURCE_TEXT_UNAVAILABLE", "source transcript is unavailable");
  return { conversation, generation, task };
}

function requestBudget(req: NextRequest) {
  const deadline = performance.now() + 20_000;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]);
  const check = () => {
    if (signal.aborted || performance.now() >= deadline) throw new ConversationDraftRefusal("SOURCE_READ_TIMEOUT", "source request deadline exceeded", 503, true);
  };
  return { signal, check, remaining: () => { check(); return Math.max(1, deadline - performance.now()); } };
}

function gitEnvironment(): Partial<NodeJS.ProcessEnv> {
  return { ...Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith("GIT_")).map(key => [key, undefined])),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
}

async function sourceCapture(req: NextRequest, input: Pick<ConversationDraftRequest, "conversationId" | "taskId">, ports: ConversationDraftPorts, budget: ReturnType<typeof requestBudget>) {
  const bound = boundSource(req, input, ports);
  const pinned = await ports.open(bound.generation.path);
  if (!pinned) refuse("SOURCE_TEXT_UNAVAILABLE", "source transcript is unavailable");
  try {
    budget.check();
    let cwd = bound.generation.launchProfile.cwd;
    let title = bound.generation.launchProfile.title;
    if (!cwd) {
      const metadata = await ports.metadata(bound.generation.path, budget.signal);
      cwd = metadata?.cwd ?? "";
      title ||= metadata?.title ?? null;
    }
    budget.check();
    let realCwd: string;
    try {
      realCwd = fs.realpathSync(cwd || refuse("SOURCE_WORKING_COPY_UNAVAILABLE", "conversation has no working copy"));
      if (!fs.statSync(realCwd).isDirectory()) refuse("SOURCE_WORKING_COPY_UNAVAILABLE", "conversation working copy is not a directory");
    }
    catch { return refuse("SOURCE_WORKING_COPY_UNAVAILABLE", "conversation working copy is unavailable"); }
    authorize(req, [projectForCwd(realCwd)]);
    const exec: ExecPort = async (command, args, directory) => {
      const result = await ports.exec(command, args, directory, gitEnvironment(), { signal: budget.signal, timeoutMs: budget.remaining(), maxOutputBytes: 1024 * 1024 });
      budget.check();
      if (result.code === null) throw new ConversationDraftRefusal("SOURCE_READ_TIMEOUT", "source Git probe did not complete", 503, true);
      return result;
    };
    const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], realCwd);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") refuse("SOURCE_WORKING_COPY_UNAVAILABLE", "conversation requires an existing Git working copy");
    const preflight = await preflightPipelineRepo(realCwd, { homeDir: os.homedir, stat: fs.statSync, access: fs.accessSync, exec });
    if (!preflight.ok) {
      if (preflight.code === "probe_failed") throw new ConversationDraftRefusal("SOURCE_READ_TIMEOUT", "source repository probe failed", 503, true);
      refuse("SOURCE_WORKING_COPY_UNAVAILABLE", "conversation requires an existing Git working copy");
    }
    const repoDir = fs.realpathSync(preflight.repoDir);
    const project = projectForCwd(repoDir);
    authorize(req, [project]);
    if (!project || canonicalProject(project) !== canonicalProject(bound.task.project)) refuse("SOURCE_PROJECT_MISMATCH", "working copy and task belong to different projects");
    const git = async (...args: string[]) => exec("git", args, repoDir);
    const facts = async () => {
      const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
      const head = await git("rev-parse", "--verify", "HEAD^{commit}");
      if (branch.code !== 0 || !branch.stdout.trim() || pipelineBaseBranchError(branch.stdout.trim()) || head.code !== 0) refuse("SOURCE_BRANCH_UNAVAILABLE", "conversation requires a named branch with a commit");
      const status = await git("status", "--porcelain", "--untracked-files=normal");
      if (status.code !== 0) refuse("SOURCE_WORKING_COPY_UNAVAILABLE", "source status is unavailable");
      return { branch: branch.stdout.trim(), head: head.stdout.trim(), dirty: !!status.stdout.trim() };
    };
    const initial = await facts();
    const gitDirectory = await git("rev-parse", "--absolute-git-dir");
    if (gitDirectory.code !== 0) refuse("SOURCE_WORKING_COPY_UNAVAILABLE", "source Git directory is unavailable");
    const originalCwd = bound.generation.launchProfile.cwd;
    const canonicalPath = fs.realpathSync(bound.generation.path);
    const common = fs.realpathSync(preflight.gitCommonDir);
    // Cheap file identities recheck refs/index at synchronous storage admission.
    // Working-copy status is prepared again after any admission contention.
    // Never run synchronous Git, or hold the state write lease over a Git probe.
    const refFiles = [path.join(gitDirectory.stdout.trim(), "HEAD"), path.join(common, "refs", "heads", initial.branch),
      path.join(common, "packed-refs"), path.join(gitDirectory.stdout.trim(), "index")];
    const refStamp = () => refFiles.map(file => {
      try { const stat = fs.statSync(file); return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    });
    const originalRefs = hash(refStamp());
    const identity = (file: string) => { const stat = fs.statSync(file); return [stat.dev, stat.ino]; };
    const repoIdentity = [identity(repoDir), identity(common)];
    const transcriptIdentity = [pinned.stat.dev, pinned.stat.ino, pinned.stat.size, pinned.stat.mtimeMs];
    const sourceRevision = hash([bound.conversation.id, bound.generation.id, bound.generation.path, canonicalPath, transcriptIdentity, repoDir, common, repoIdentity, initial.branch, initial.head]);
    const assertCurrent = () => {
      budget.check();
      const current = boundSource(req, input, ports);
      const stat = fs.fstatSync(pinned.descriptor);
      try {
        if (current.conversation.id !== bound.conversation.id || current.generation.id !== bound.generation.id
          || current.generation.path !== bound.generation.path || current.generation.launchProfile.cwd !== originalCwd
          || !pinned.sameIdentity() || fs.realpathSync(bound.generation.path) !== canonicalPath
          || hash([stat.dev, stat.ino, stat.size, stat.mtimeMs]) !== hash(transcriptIdentity)
          || fs.realpathSync(cwd) !== realCwd || fs.realpathSync(preflight.gitCommonDir) !== common
          || hash(refStamp()) !== originalRefs
          || hash([identity(repoDir), identity(common)]) !== hash(repoIdentity)) refuse("SOURCE_CHANGED", "source changed; refresh the preview");
      } catch (error) {
        if (error instanceof ConversationDraftRefusal) throw error;
        refuse("SOURCE_CHANGED", "source changed; refresh the preview");
      }
      authorize(req, [project]);
    };
    const recheck = async (allowDirty = false) => {
      const current = await facts();
      assertCurrent();
      if (current.branch !== initial.branch || current.head !== initial.head) refuse("SOURCE_CHANGED", "source branch changed; refresh the preview");
      if (current.dirty && !allowDirty) refuse("SOURCE_HAS_CHANGES", "Commit the conversation's changes before creating a pipeline.");
      return current;
    };
    assertCurrent();
    return { ...bound, ...initial, pinned, repoDir, project, sourceRevision, assertCurrent, recheck,
      title: visible(title || bound.conversation.id, 240) };
  } catch (error) { fs.closeSync(pinned.descriptor); throw error; }
}

/** Bounded visible quotations, all read from the descriptor's captured cutoff. */
export function conversationExcerpt(pinned: PinnedTranscript, engine: "claude" | "codex" | "copilot") {
  const head = Buffer.alloc(Math.min(pinned.stat.size, 64 * 1024));
  const bytes = fs.readSync(pinned.descriptor, head, 0, head.length, 0);
  let first: string | undefined;
  for (const line of head.subarray(0, bytes).toString("utf8").split("\n").slice(0, 151)) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    first = normalizeSessionLine(engine, raw as Record<string, unknown>)
      .find(row => row.record.kind === "message" && row.record.role === "user" && row.record.text.trim())?.record.text;
    if (first) break;
  }
  let remaining = 1024 * 1024 - bytes;
  let cursor: MessagesPageCursor | null = null;
  const recent: { role: string; text: string; truncated?: true }[] = [];
  let truncated = false;
  for (let pageNumber = 0; pageNumber < 4 && remaining > 0 && recent.length < 6; pageNumber++) {
    const page = readMessagesPage({ descriptor: pinned.descriptor, size: pinned.stat.size, engine }, {
      kinds: new Set(["message"]), roles: new Set(["user", "assistant"]), limit: 6 - recent.length,
      maxChars: 700, maxScanBytes: remaining, cursor,
    });
    remaining -= page.scanned.bytes;
    recent.push(...page.records.filter(record => record.text.trim()).map(record => ({ role: record.role, text: visible(record.text, 700), truncated: record.truncated })));
    truncated ||= page.hasMore || page.scanned.capped || page.records.some(record => record.truncated);
    cursor = page.cursor;
    if (!page.hasMore || !cursor) break;
  }
  const firstText = first ? visible(first, 1000).trim() : "";
  if (!firstText && !recent.length) refuse("SOURCE_TEXT_UNAVAILABLE", "source has no visible conversation messages");
  const ordered = recent.reverse();
  const firstIncluded = first && ordered.some(record => record.role === "user" && record.text === visible(first, 700));
  return { first: firstIncluded ? "" : firstText, recent: ordered, truncated: truncated || !!first && first.length > 1000 };
}

export async function previewConversationDraft(req: NextRequest, input: Pick<ConversationDraftRequest, "conversationId" | "taskId">, ports = conversationDraftPorts()): Promise<ConversationDraftPreview> {
  return withViewerOperation("pipelines.from-conversation.preview", async () => {
    const source = await sourceCapture(req, input, ports, requestBudget(req));
    try {
      const current = await source.recheck(true);
      return { ok: true, source: {
        conversationId: source.conversation.id, title: source.title, branch: source.branch, head: source.head,
        sourceRevision: source.sourceRevision, canCreate: !current.dirty,
        ...(current.dirty ? { refusal: { code: "SOURCE_HAS_CHANGES", error: "Commit the conversation's changes before creating a pipeline." } } : {}),
      } };
    } finally { fs.closeSync(source.pinned.descriptor); }
  });
}

export async function createConversationDraft(req: NextRequest, input: ConversationDraftRequest, ports = conversationDraftPorts()): Promise<PipelineMutationResult & { status: number }> {
  const budget = requestBudget(req);
  boundSource(req, input, ports);
  const principal = requestWorkspaceScope(req)?.memberId ?? "solo";
  const creationRequest = { key: `conversation-draft:${hash([principal, input.clientRequestId])}`, digest: hash([input.conversationId, input.taskId, input.sourceRevision]) };
  const admitReplay = (pipeline: Pipeline) => {
    boundSource(req, input, ports);
    authorize(req, [pipeline.project, projectForCwd(pipeline.repoDir)]);
  };
  const replay = () => {
    const pipeline = pipelineDeliveryLookup({ requestKey: creationRequest.key });
    if (!pipeline) return null;
    admitReplay(pipeline);
    if (pipeline.creationRequest?.digest !== creationRequest.digest) refuse("idempotency_conflict", "creation arguments changed");
    return { pipeline, status: 200 };
  };
  const existing = replay();
  if (existing) return existing;
  let descriptor: number | undefined;
  try {
    const source = await withViewerOperation("pipelines.from-conversation.capture", () => sourceCapture(req, input, ports, budget));
    descriptor = source.pinned.descriptor;
    if (source.sourceRevision !== input.sourceRevision) refuse("SOURCE_CHANGED", "source changed; refresh the preview");
    if (source.dirty) refuse("SOURCE_HAS_CHANGES", "Commit the conversation's changes before creating a pipeline.");
    const excerpt = withViewerOperation("pipelines.from-conversation.capture", () => conversationExcerpt(source.pinned, source.conversation.engine));
    const capturedAt = ports.now();
    const heading = `{{task}}\n\nConversation: ${source.title}\nSource: ${source.conversation.id}\nCaptured: ${capturedAt}\n`;
    const quotations = [excerpt.first ? `First user request:\n${excerpt.first}` : "",
      `Recent messages${excerpt.truncated ? " (excerpt; earlier messages or characters omitted)" : ""}:`,
      ...excerpt.recent.map(record => `${record.role}:\n${record.text}`)].filter(Boolean).join("\n\n");
    const prompt = heading + clip(quotations, MAX_STAGE_PROMPT_LENGTH - heading.length);
    const task = clip(source.task.text.split(/\r?\n/).find(line => line.trim())?.trim() ?? "", MAX_TASK_LENGTH);
    const exec: ExecPort = async (command, args, cwd, _env, options) => {
      const result = await ports.exec(command, args, cwd, gitEnvironment(), { ...options, signal: budget.signal, timeoutMs: budget.remaining(), maxOutputBytes: 1024 * 1024 });
      budget.check();
      return result;
    };
    const result = await withViewerOperation("pipelines.from-conversation.create", () => createPipelineFromRequest({
      task, taskIds: [source.task.id], finishesTask: false, repoDir: source.repoDir, baseBranch: source.branch, baseRef: source.head,
      autoStart: false, stages: [
        { id: "builder", kind: "run", role: { roleId: "builder" }, prompt, next: "reviewer" },
        { id: "reviewer", kind: "run", role: { roleId: "reviewer" }, prompt: "{{prev.output}}", next: null,
          onFail: { to: "builder", maxRounds: 2, onExhausted: "advance" } },
      ],
    }, { ...ports.pipeline, exec, preflightRepo: directory => preflightPipelineRepo(directory, {
      homeDir: os.homedir, stat: fs.statSync, access: fs.accessSync, exec,
    }) }, {
      briefer: { kind: "operator" }, allowOperatorDraftWithoutLineage: true, queueWhenBusy: false, creationRequest,
      conversationSource: { conversationId: source.conversation.id, branch: source.branch, head: source.head, capturedAt },
      beforeConversationCreate: async () => { await source.recheck(); }, admitConversationCreate: source.assertCurrent,
      admitConversationReplay: admitReplay,
    }));
    if (!result.pipeline) return replay() ?? { ...result, status: result.status ?? 400 };
    admitReplay(result.pipeline);
    return { ...result, status: result.replayed ? 200 : 201 };
  } catch (error) {
    // A peer can commit after the first lookup, including during source capture.
    const committed = replay();
    if (committed) return committed;
    throw error;
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
