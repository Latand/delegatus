import type { AgentRegistry, SpawnReceipt } from "@/lib/agent/registry";
import { appendLifecycleEvents, type LifecycleEventInput } from "@/lib/lifecycle/journal";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import type { FileEntry } from "@/lib/types";
import { codexThreadIdFromPath, nativeCodexParentThreadId } from "@/lib/scanner/codexNative";
import { tailRecordsResult } from "@/lib/scanner/activity";
import type { RuntimeEvent } from "./engineHost";

const nativeMethods = new Set(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent",
  "spawn_agent", "resume_agent", "send_input", "close_agent", "followup_task", "send_message", "wait_agent", "interrupt_agent", "list_agents"]);
const transcriptObservations = new WeakMap<AgentRegistry, Map<string, string>>();

/** Native events contain task text. Only a fixed method label enters the alert. */
export function nativeCodexActivityMethod(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const source = item as Record<string, unknown>;
  if (source.type === "subAgentActivity") return "subAgentActivity";
  if (source.type !== "collabAgentToolCall") return null;
  return typeof source.tool === "string" && nativeMethods.has(source.tool) ? source.tool : "collabAgentToolCall";
}

export function recordCodexSubagentViolation(
  registry: AgentRegistry,
  parentPath: string,
  evidenceKey: string,
  method: string,
  at = new Date().toISOString(),
  append = appendLifecycleEvents,
  receipts?: readonly SpawnReceipt[],
  activityAt = at,
): boolean {
  const conversation = registry.conversationForPath(parentPath);
  if (!conversation || conversation.engine !== "codex") return false;
  const generation = conversation.generations.find((candidate) => candidate.path === parentPath);
  if (generation?.launchProfile.allowSubagents !== false) return false;
  // Scanner imports also have a default false profile. A launch receipt proves
  // Delegatus actually imposed the permission on this conversation.
  const launched = (receipts ?? Object.values(registry.readOnlySnapshot().receipts)).filter((receipt) =>
    receipt.engine === "codex" && receipt.artifactPath === parentPath
    && Date.parse(receipt.createdAt) <= Date.parse(activityAt))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (launched?.launchProfile.allowSubagents !== false) return false;
  const event: LifecycleEventInput = {
    key: `codex-subagent-policy:${conversation.id}:${evidenceKey}`,
    type: "subagent_policy_violation", at,
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
  recordCodexSubagentViolation(registry, parentPath, `item:${key}`, method);
}

/** Covers terminal CLI and headless exec as well as a child whose live parent
 * event was missed. Native headers and typed tool records provide evidence. */
export function observeCodexSubagentTranscripts(registry: AgentRegistry, entries: readonly FileEntry[]): void {
  const parents = new Map<string, string>();
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
    if (parentPath && child) {
      receipts ??= Object.values(registry.readOnlySnapshot().receipts);
      recordCodexSubagentViolation(registry, parentPath, `child:${child}`, "thread_spawn", at,
        collect, receipts, entry.sessionStartedAt ?? at);
    }
  }
  // Calls whose child never materializes are still native activity. Reuse the
  // scanner's bounded tail reader; never search conversation prose or scripts.
  if (entries.some((entry) => entry.engine === "codex")) receipts ??= Object.values(registry.readOnlySnapshot().receipts);
  const deniedPaths = new Set(receipts?.filter((receipt) => receipt.engine === "codex" && receipt.launchProfile.allowSubagents === false)
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
    for (const row of tail.records) {
      const payload = row.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") continue;
      let method: string | null = null;
      if (row.type === "response_item" && payload.type === "function_call" && typeof payload.name === "string") {
        const name = payload.name.replace(/^(collaboration|functions)\./, "");
        if (nativeMethods.has(name)) method = name;
      } else if (row.type === "event_msg") method = nativeCodexActivityMethod(payload);
      if (!method) continue;
      const id = payload.call_id ?? payload.id;
      if (typeof id !== "string") continue;
      recordCodexSubagentViolation(registry, entry.path, `item:${id}`, method, at, collect, receipts,
        typeof row.timestamp === "string" ? row.timestamp : at);
    }
    completed.push([entry.path, signature]);
  }
  // One journal transaction and one receipt snapshot per inventory, including
  // historical children, rather than a registry/journal scan for each child.
  appendLifecycleEvents(events);
  // A failed journal write leaves every candidate eligible for the next tick.
  for (const [pathname, signature] of completed) {
    if (observations.size >= 4096) observations.delete(observations.keys().next().value!);
    observations.set(pathname, signature);
  }
}
