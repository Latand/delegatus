import fs from "node:fs";
import path from "node:path";
import type { AgentRegistry, SpawnReceipt } from "@/lib/agent/registry";
import { appendLifecycleEvents, type LifecycleEventInput } from "@/lib/lifecycle/journal";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import type { FileEntry } from "@/lib/types";
import { codexThreadIdFromPath, nativeCodexParentThreadId } from "@/lib/scanner/codexNative";
import { tailRecordsResult } from "@/lib/scanner/activity";
import { statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { writeJsonDurably } from "@/lib/state/durableJson";
import type { RuntimeEvent } from "./engineHost";

// The first detector process defines the deployment boundary. Persist it so
// restarting the Viewer cannot reclassify missed live activity as old history.
const processObservationStart = new Date().toISOString();
const observationStarts = new Map<string, string>();
function observationStart(): string {
  const filename = statePath("codex-subagent-observation.json");
  const cached = observationStarts.get(filename);
  if (cached) return cached;
  const startedAt = withFileTransactionSync(filename, "Codex sub-agent observation boundary is busy", () => {
    try {
      const value = JSON.parse(fs.readFileSync(filename, "utf8")) as { startedAt?: unknown };
      if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) {
        throw new Error("Codex sub-agent observation boundary is invalid");
      }
      return value.startedAt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      writeJsonDurably(filename, { startedAt: processObservationStart });
      return processObservationStart;
    }
  });
  if (observationStarts.size >= 32) observationStarts.delete(observationStarts.keys().next().value!);
  observationStarts.set(filename, startedAt);
  return startedAt;
}

const nativeMethods = new Set(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent",
  "spawn_agent", "resume_agent", "send_input", "close_agent", "followup_task", "send_message", "wait_agent", "interrupt_agent", "list_agents"]);
const transcriptObservations = new WeakMap<AgentRegistry, Map<string, string>>();
const childObservations = new WeakMap<AgentRegistry, Set<string>>();
const v1Methods = new Set(["spawn_agent", "resume_agent", "send_input", "wait", "wait_agent", "close_agent"]);
const v2Methods = new Set(["spawn_agent", "followup_task", "send_message", "wait_agent", "interrupt_agent", "list_agents"]);

/** A reserved resume intent has not imposed its profile on a native process. */
function hasCodexLaunchEvidence(receipt: SpawnReceipt): boolean {
  return receipt.key?.engine === "codex" || receipt.verifiedHost != null;
}

/** The native transcript stores namespace separately from the method name. */
export function nativeCodexFunctionCallMethod(payload: Record<string, unknown>, toolNamespaces: ReadonlySet<string> = new Set(["collaboration"])): string | null {
  const name = payload.name;
  if (typeof name !== "string") return null;
  const namespace = payload.namespace;
  if (namespace != null) {
    if (typeof namespace !== "string" || namespace.startsWith("mcp__")) return null;
    if (namespace === "multi_agent_v1") return v1Methods.has(name) ? name : null;
    return toolNamespaces.has(namespace) && v2Methods.has(name) ? name : null;
  }
  // Legacy v1 and providers without namespace_tools expose bare native names.
  if (!v1Methods.has(name) && !v2Methods.has(name)) return null;
  if (name === "wait") {
    try {
      const args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments;
      if (!args || typeof args !== "object" || "cell_id" in args || !Array.isArray(args.ids)
        || !args.ids.length || !args.ids.every((id: unknown) => typeof id === "string")) return null;
    } catch { return null; }
  }
  return name;
}

/** Read only the namespace setting for an unusual tool namespace. Session
 * roots identify their account home without opening mutable account stores. */
function configuredToolNamespaces(entry: Pick<FileEntry, "path" | "cwd">): Set<string> {
  const namespaces = new Set(["collaboration"]);
  const sessionRoot = entry.path.lastIndexOf(`${path.sep}sessions${path.sep}`);
  const configs = [
    ...(sessionRoot >= 0 ? [path.join(entry.path.slice(0, sessionRoot), "config.toml")] : []),
    ...(entry.cwd ? [path.join(entry.cwd, ".codex", "config.toml")] : []),
  ];
  for (const filename of configs) {
    try {
      if (fs.statSync(filename).size > 1024 * 1024) continue;
      const config = Bun.TOML.parse(fs.readFileSync(filename, "utf8")) as { features?: { multi_agent_v2?: { tool_namespace?: unknown } } };
      const namespace = config.features?.multi_agent_v2?.tool_namespace;
      if (typeof namespace === "string" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(namespace) && !namespace.startsWith("mcp__")) namespaces.add(namespace);
    } catch { /* Missing or unreadable config supplies no namespace evidence. */ }
  }
  return namespaces;
}

/** Native events contain task text. Only a fixed method label enters the alert. */
export function nativeCodexActivityMethod(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const source = item as Record<string, unknown>;
  if (source.type === "autoApprovalReview" || source.type === "guardian_assessment") return "autoApprovalReview";
  if (source.type === "subAgentActivity" || source.type === "SubAgentActivity" || source.type === "sub_agent_activity") return "subAgentActivity";
  if (source.type !== "collabAgentToolCall" && source.type !== "CollabAgentToolCall") return null;
  return typeof source.tool === "string" && nativeMethods.has(source.tool) ? source.tool : "collabAgentToolCall";
}

/** Native rollout EventMsg and TurnItem schemas differ from app-server items. */
function nativeTranscriptEvent(payload: Record<string, unknown>): { method: string; id: string } | null {
  const item = payload.type === "item_completed" || payload.type === "item_started" ? payload.item : payload;
  const method = nativeCodexActivityMethod(item);
  if (!method) return null;
  const source = item as Record<string, unknown>;
  const id = source.event_id ?? source.call_id ?? source.id;
  return typeof id === "string" ? { method, id } : null;
}

function transcriptActivityTime(row: Record<string, unknown>, payload: Record<string, unknown>): string | undefined {
  for (const field of ["occurred_at_ms", "started_at_ms", "completed_at_ms"]) {
    const value = payload[field];
    if (typeof value === "number" && value > 0 && Number.isFinite(new Date(value).getTime())) return new Date(value).toISOString();
  }
  return typeof row.timestamp === "string" ? row.timestamp : undefined;
}

export function recordCodexSubagentViolation(
  registry: AgentRegistry,
  parentPath: string,
  _evidenceKey: string,
  method: string,
  at = new Date().toISOString(),
  append = appendLifecycleEvents,
  receipts?: readonly SpawnReceipt[],
  activityAt = at,
): boolean {
  if (!Number.isFinite(Date.parse(activityAt)) || Date.parse(activityAt) < Date.parse(observationStart())) return false;
  const conversation = registry.conversationForPath(parentPath);
  if (!conversation || conversation.engine !== "codex") return false;
  const generation = conversation.generations.find((candidate) => candidate.path === parentPath);
  if (!generation) return false;
  // Scanner imports also have a default false profile. A launch receipt proves
  // Delegatus actually imposed the permission on this conversation.
  const launched = (receipts ?? Object.values(registry.readOnlySnapshot().receipts)).filter((receipt) =>
    receipt.engine === "codex" && receipt.artifactPath === parentPath && hasCodexLaunchEvidence(receipt)
    && Date.parse(receipt.createdAt) <= Date.parse(activityAt))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (launched?.launchProfile.allowSubagents !== false) return false;
  const event: LifecycleEventInput = {
    // One durable alert per conversation, shared by child headers and items.
    key: `codex-subagent-policy:${conversation.id}`,
    type: "subagent_policy_violation", at: activityAt,
    conversationId: conversation.id,
    project: conversationProjectKey(conversation.projectOwnership, generation.launchProfile),
    role: conversation.agentRole ?? null,
    summary: `Native Codex sub-agent activity observed with sub-agents disabled: ${method}.`,
  };
  append([event]);
  return true;
}

/** The app-server's durable item ledger replays through the same observer. */
export function observeCodexSubagentEvent(registry: AgentRegistry, parentPath: string, event: RuntimeEvent): void {
  if (event.kind !== "item") return;
  const method = nativeCodexActivityMethod(event.item);
  if (!method) return;
  const item = event.item as Record<string, unknown>;
  const key = typeof item.id === "string" ? item.id : `event-${event.seq}`;
  const activityAt = event.activityAt === null ? transcriptActivityAt(registry, parentPath, key) : event.activityAt;
  // History with no authoritative time cannot be assigned to a launch receipt.
  // The scanner still checks native transcript calls and child headers.
  if (activityAt === null || (activityAt !== undefined && !Number.isFinite(Date.parse(activityAt)))) return;
  recordCodexSubagentViolation(registry, parentPath, `item:${key}`, method, undefined, undefined, undefined, activityAt);
}

function transcriptActivityAt(registry: AgentRegistry, parentPath: string, id: string): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(parentPath); } catch { return null; }
  const tail = tailRecordsResult(parentPath, stat.size, stat.mtimeMs);
  if (!tail.complete) return null;
  const cwd = registry.conversationForPath(parentPath)?.generations.find((generation) => generation.path === parentPath)?.launchProfile.cwd;
  const namespaces = configuredToolNamespaces({ path: parentPath, cwd });
  for (const row of tail.records) {
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;
    const method = row.type === "response_item" && payload.type === "function_call"
      ? nativeCodexFunctionCallMethod(payload, namespaces) : null;
    const evidence = method && typeof payload.call_id === "string" ? { method, id: payload.call_id }
      : row.type === "event_msg" ? nativeTranscriptEvent(payload) : null;
    const activityAt = transcriptActivityTime(row, payload);
    if (evidence?.id === id && activityAt && Number.isFinite(Date.parse(activityAt))) return activityAt;
  }
  return null;
}

/** Covers terminal CLI and headless exec as well as a child whose live parent
 * event was missed. Native headers and typed tool records provide evidence. */
export function observeCodexSubagentTranscripts(registry: AgentRegistry, entries: readonly FileEntry[]): void {
  try { collectCodexSubagentTranscripts(registry, entries); }
  catch {
    // Keep pipelines, migrations and the other controllers running. No
    // observation is acknowledged until its journal transaction succeeds.
    console.error("[codex sub-agent policy] transcript observation could not be recorded; retrying next tick");
  }
}

function collectCodexSubagentTranscripts(registry: AgentRegistry, entries: readonly FileEntry[]): void {
  observationStart();
  const parents = new Map<string, string>();
  const children = childObservations.get(registry) ?? new Set<string>();
  childObservations.set(registry, children);
  const completedChildren: string[] = [];
  let receipts: SpawnReceipt[] | undefined;
  const events: LifecycleEventInput[] = [];
  const at = new Date().toISOString();
  const collect: typeof appendLifecycleEvents = (inputs) => { events.push(...inputs); return { appended: [], skipped: 0 }; };
  for (const entry of entries) {
    if (entry.engine !== "codex") continue;
    const thread = codexThreadIdFromPath(entry.path);
    if (thread) parents.set(thread, entry.path);
  }
  for (const entry of entries) {
    if (entry.engine !== "codex") continue;
    const parent = nativeCodexParentThreadId(entry.path, entry.size, entry.mtime * 1000);
    const parentPath = parent ? parents.get(parent) : null;
    const child = codexThreadIdFromPath(entry.path);
    if (parentPath && child && entry.sessionStartedAt) {
      const key = `${parentPath}:${child}`;
      if (children.has(key)) continue;
      receipts ??= Object.values(registry.readOnlySnapshot().receipts);
      if (recordCodexSubagentViolation(registry, parentPath, `child:${child}`, "thread_spawn", at,
        collect, receipts, entry.sessionStartedAt)) completedChildren.push(key);
    }
  }
  // Calls whose child never materializes are still native activity. Reuse the
  // scanner's bounded tail reader; never search conversation prose or scripts.
  if (entries.some((entry) => entry.engine === "codex")) receipts ??= Object.values(registry.readOnlySnapshot().receipts);
  const deniedPaths = new Set(receipts?.filter((receipt) => receipt.engine === "codex" && hasCodexLaunchEvidence(receipt) && receipt.launchProfile.allowSubagents === false)
    .map((receipt) => receipt.artifactPath));
  const observations = transcriptObservations.get(registry) ?? new Map<string, string>();
  transcriptObservations.set(registry, observations);
  const completed: Array<[string, string]> = [];
  let remaining = 8 * 1024 * 1024;
  for (const entry of entries) {
    if (entry.engine !== "codex" || !deniedPaths.has(entry.path)) continue;
    const signature = `${entry.size}:${entry.mtime}`;
    if (observations.get(entry.path) === signature) continue;
    const bytes = Math.min(entry.size, 131_072);
    if (bytes > remaining) continue;
    remaining -= bytes;
    const tail = tailRecordsResult(entry.path, entry.size, entry.mtime * 1000);
    if (!tail.complete) continue;
    let namespaces: ReadonlySet<string> | undefined;
    for (const row of tail.records) {
      const payload = row.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") continue;
      let method: string | null = null;
      let id: unknown;
      if (row.type === "response_item" && payload.type === "function_call" && typeof payload.name === "string") {
        if (typeof payload.namespace === "string" && payload.namespace !== "collaboration" && payload.namespace !== "multi_agent_v1"
          && !payload.namespace.startsWith("mcp__") && v2Methods.has(payload.name)) namespaces ??= configuredToolNamespaces(entry);
        method = nativeCodexFunctionCallMethod(payload, namespaces);
        id = payload.call_id;
      } else if (row.type === "event_msg") {
        const evidence = nativeTranscriptEvent(payload);
        method = evidence?.method ?? null;
        id = evidence?.id;
      }
      if (!method) continue;
      if (typeof id !== "string") continue;
      const activityAt = transcriptActivityTime(row, payload);
      if (activityAt) recordCodexSubagentViolation(registry, entry.path, `item:${id}`, method, at, collect, receipts, activityAt);
    }
    completed.push([entry.path, signature]);
  }
  // One journal transaction and one receipt snapshot per inventory, including
  // historical children, rather than a registry/journal scan for each child.
  if (events.length) appendLifecycleEvents(events);
  for (const key of completedChildren) {
    if (children.size >= 4096) children.delete(children.values().next().value!);
    children.add(key);
  }
  // A failed journal write leaves every candidate eligible for the next tick.
  for (const [pathname, signature] of completed) {
    if (observations.size >= 4096) observations.delete(observations.keys().next().value!);
    observations.set(pathname, signature);
  }
}
