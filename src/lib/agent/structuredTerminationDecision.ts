import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { defaultRuntimeHostEndpoint, runtimeHostFencePath } from "@/lib/runtime/localEndpoint";
import { registryConversationKeysForEntryKey } from "./sqliteRegistryStore";
import type { AgentRegistryEntry, RegistryFile } from "./registry";

const MAX_RELATED = 4;
const MAX_OWNER_BYTES = 4096;
const prefix = "structured-host:";
const epoch = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
// Opaque provider/orchestration references can contain arbitrary text. Keep
// correlation without copying that text, even from malformed persisted rows.
const reference = (value: unknown): string | null => typeof value === "string" && value.length > 0
  ? `sha256:${createHash("sha256").update(value).digest("hex")}` : null;
const startIdentity = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 80 && /^\d+:\d+(?::\d+)?$/.test(value) ? value : reference(value);
const bootEpoch = (value: unknown): string | null => typeof value === "string" && value.length <= 160
  && /^(?:linux:[a-f0-9-]{36}:pidns:pid:\[\d+\]|darwin:\d+:\d+|windows:absolute-process-creation-filetime)$/.test(value)
  ? value : reference(value);

function ownerIdentity(value: unknown): ProcessIdentity | null {
  if (typeof value !== "string" || value.length > MAX_OWNER_BYTES || !value.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(value.slice(prefix.length));
    if (!parsed || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return null;
    return { pid: parsed.pid, startIdentity: typeof parsed.startIdentity === "string" ? parsed.startIdentity : null,
      bootEpoch: typeof parsed.bootEpoch === "string" ? parsed.bootEpoch : null };
  } catch { return null; }
}

/** The fence acquisition identifies the running generation, including local
 * checkout installs. A staged release file can already name a future host.
 * This observation never acquires the fence or changes a stop authorization. */
function runtimeHostGeneration(registryFilename: string): Record<string, unknown> {
  const directory = path.dirname(registryFilename);
  const socket = process.env.LLV_RUNTIME_HOST_SOCKET || defaultRuntimeHostEndpoint(directory).socketPath;
  const filename = process.env.LLV_RUNTIME_HOST_FENCE?.trim() || runtimeHostFencePath(socket, directory);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OWNER_BYTES) return { state: "invalid" };
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { state: "invalid" };
    const raw = JSON.parse(bytes.toString("utf8"));
    if (!raw || !Number.isSafeInteger(raw.pid) || raw.pid <= 0
      || typeof raw.startIdentity !== "string"
      || typeof raw.acquisitionId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(raw.acquisitionId)) return { state: "invalid" };
    return { state: "read", pid: raw.pid, startIdentity: startIdentity(raw.startIdentity), acquisitionId: raw.acquisitionId };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  } finally {
    // Diagnostic cleanup cannot turn an otherwise admitted stop into a refusal.
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* observation only */ } }
  }
}

function conversationOwnership(file: RegistryFile, entry: AgentRegistryEntry): Record<string, unknown> {
  try {
    const key = `${entry.key.engine}:${entry.key.sessionId}`;
    const keys = registryConversationKeysForEntryKey(file, key);
    const related = keys ?? Object.keys(file.conversations).filter(id => file.conversations[id]!.generations
      .some(generation => `${file.conversations[id]!.engine}:${generation.id}` === key));
    const conversations = related.slice(0, MAX_RELATED).map(id => {
      const conversation = file.conversations[id]!;
      const memberships = file.memberships[id] ?? [];
      return {
        id: reference(conversation.id), currentGeneration: conversation.generations.at(-1)?.id === entry.key.sessionId,
        turnState: ["unknown", "idle", "busy", "terminal"].includes(conversation.turn.state) ? conversation.turn.state : null,
        memberships: memberships.slice(0, MAX_RELATED).map(row => ({
          kind: ["flow", "pipeline", "orchestrator"].includes(row.kind) ? row.kind : null,
          containerId: reference(row.containerId), stageId: reference(row.stageId),
          stageOrder: epoch(row.stageOrder), round: epoch(row.round), parentConversationId: reference(row.parentConversationId),
        })), membershipsTruncated: memberships.length > MAX_RELATED,
      };
    });
    return { ownershipState: "read", conversations, conversationsTruncated: related.length > MAX_RELATED };
  } catch {
    // A lazy related-row read may fail after the stop's existing guards passed.
    // Keep that proof unavailable; collecting diagnostics authorizes no effect.
    return { ownershipState: "unreadable", conversations: [], conversationsTruncated: false };
  }
}

/** Called with the capture's locked registry view. Only fixed enums, numeric
 * epochs, process tokens and hashed references leave this serializer. At most
 * four conversations and four memberships each fit in one bounded journal row. */
export function structuredTerminationDecision(
  file: RegistryFile,
  entry: AgentRegistryEntry,
  context: { caller: string | null; claimRefusal: string | null },
  registryFilename: string,
): Record<string, unknown> {
  const owner = ownerIdentity(entry.claimOwner);
  let ownerState = owner ? "unverified" : entry.claimOwner == null ? "absent" : "invalid";
  if (owner) { try { ownerState = processIdentityStatus(owner); } catch { /* missing kernel observation */ } }

  return {
    ...context,
    reason: "orphan-writer-not-blocking",
    ownerPid: owner?.pid ?? null,
    ownerStartIdentity: startIdentity(owner?.startIdentity), ownerBootEpoch: bootEpoch(owner?.bootEpoch),
    ownerState,
    claimEpoch: epoch(entry.claimEpoch), writerClaimEpoch: epoch(entry.structuredHost?.writerClaimEpoch),
    status: ["starting", "live", "idle", "handoff", "unhosted", "dead"].includes(entry.status) ? entry.status : null,
    activeTurnRef: reference(entry.structuredHost?.activeTurnRef),
    turnOpen: typeof entry.structuredHost?.activeTurnRef === "string" && entry.structuredHost.activeTurnRef.length > 0,
    ...conversationOwnership(file, entry),
    runtimeHostGeneration: runtimeHostGeneration(registryFilename),
  };
}
